import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The compose file is the deployment most operators actually run, and nothing
// else in the gate reads it: a service without a restart policy stays down
// after a host reboot, and a proxy that forgets X-Forwarded-For turns the
// rate-limit key into a header the client picks. A log without a cap grows on
// the Docker disk, the one whose flood stage turns the index read-only. An
// image healthcheck that asks a readiness path marks the server unhealthy
// whenever Elasticsearch is down. Each is cheap to state here and expensive to
// notice in production.
//
// Parsed by indentation instead of a YAML dependency: the file is ours, and a
// parser would be a dependency the gate has to keep alive.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string[]} */ ...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const COMPOSE = read('docker-compose.yml');
const NGINX_TEMPLATE = read('client', 'nginx.conf.template');
const SERVER_DOCKERFILE = read('server', 'Dockerfile');
const CLIENT_DOCKERFILE = read('client', 'Dockerfile');

/**
 * The `services:` block as `{ name, body }`, one entry per service.
 *
 * @returns {{ name: string; body: string }[]}
 */
function composeServices() {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((line) => /^services:\s*$/.test(line));
  assert.notEqual(start, -1, 'docker-compose.yml has no top-level `services:` block');
  /** @type {{ name: string; body: string }[]} */
  const services = [];
  /** @type {{ name: string; body: string } | null} */
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break; // the next top-level key (volumes:) ends the block
    }
    const header = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = { name: header[1] ?? '', body: '' };
      services.push(current);
      continue;
    }
    if (current) {
      current.body += `${line}\n`;
    }
  }
  return services;
}

/**
 * The lines nested under `key:` in one service body, or null without the key.
 *
 * @param {string} body
 * @param {string} key
 */
function nestedBlock(body, key) {
  const lines = body.split('\n');
  const header = new RegExp(`^ {4}${key}:\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    return null;
  }
  /** @type {string[]} */
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {5,}/.test(line)) {
      break; // back at the service's own keys
    }
    block.push(line);
  }
  return block.join('\n');
}

/**
 * One `location <match> { ... }` block of the nginx template, braces
 * balanced, or null when the template has none.
 *
 * @param {string} match
 */
function nginxLocation(match) {
  const start = NGINX_TEMPLATE.indexOf(`location ${match} {`);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = NGINX_TEMPLATE.indexOf('{', start); index < NGINX_TEMPLATE.length; index += 1) {
    const char = NGINX_TEMPLATE[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return NGINX_TEMPLATE.slice(start, index + 1);
      }
    }
  }
  return null;
}

/**
 * What one `location <match>` block sets for every request it serves: its
 * body with the blocks nested in it cut out, because a directive inside an
 * `if` applies only to the requests that branch takes. Null when the
 * template has no such location.
 *
 * @param {string} match
 */
function nginxLocationOwn(match) {
  const block = nginxLocation(match);
  if (block === null) {
    return null;
  }
  // `${API_TOKEN}` names a variable, not a block: `$API_TOKEN` to the scan
  const body = block.slice(block.indexOf('{') + 1, -1).replace(/\$\{(\w+)\}/g, '$$$1');
  let depth = 0;
  let own = '';
  for (const char of body) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (depth === 0) {
      own += char;
    }
  }
  return own;
}

test('every compose service carries a restart policy', () => {
  const services = composeServices();
  // A parse that found nothing would make the assertion below vacuous
  assert.deepEqual(
    services.map((service) => service.name).sort(),
    ['client', 'elasticsearch', 'server'],
    'docker-compose.yml no longer lists the three expected services',
  );
  for (const service of services) {
    assert.match(
      service.body,
      /^\s+restart:\s*\S+/m,
      `docker-compose.yml: service "${service.name}" has no restart policy, so it stays down after a host reboot`,
    );
  }
});

test('the shipped proxy sends the header the server trusts', () => {
  assert.match(
    NGINX_TEMPLATE,
    /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/,
    'client/nginx.conf.template must forward X-Forwarded-For, or the server trusts a header the client supplies',
  );
});

test('the proxy tells the server which address the browser used', () => {
  // A write without Sec-Fetch-Site (curl, an older browser, a plain-HTTP LAN
  // address) is judged by its Origin, which the server compares with this
  // address, port included; $host drops the port. An ALLOWED_HOSTS name
  // passes on any port anyway, a loopback one only this way.
  const api = nginxLocationOwn('/api/');
  assert.ok(api, 'client/nginx.conf.template has no `location /api/` block');
  assert.match(
    api,
    /^\s*proxy_set_header\s+X-Forwarded-Host\s+\$http_host;/m,
    'location /api/ must forward X-Forwarded-Host $http_host, or an unmarked write from the UI on a loopback port is refused',
  );
  assert.match(
    api,
    /^\s*proxy_set_header\s+Host\s+\$host;/m,
    'location /api/ must keep forwarding Host $host for the server Host check',
  );
});

test('the UI pages refuse to be framed', () => {
  // Inside a frame the UI sends its requests with its own Origin, so only the
  // browser refusing the frame keeps a hostile page from steering its clicks
  const pages = nginxLocationOwn('/');
  assert.ok(pages, 'client/nginx.conf.template has no `location /` block');
  assert.match(
    pages,
    /^\s*add_header\s+Content-Security-Policy\s+"frame-ancestors 'none'"\s+always;/m,
    "location / must send frame-ancestors 'none' on every answer",
  );
  assert.match(
    pages,
    /^\s*add_header\s+X-Frame-Options\s+"?DENY"?\s+always;/m,
    'location / must send X-Frame-Options DENY on every answer',
  );
  /** @param {string} text */
  const addHeaderLines = (text) => text.split('\n').filter((line) => /^\s*add_header\b/.test(line)).length;
  assert.equal(
    addHeaderLines(NGINX_TEMPLATE),
    addHeaderLines(pages),
    'add_header belongs in `location /` only: elsewhere it doubles the headers helmet sets on /api/',
  );
});

test('the compose stack never asks the server to trust every hop', () => {
  const line = COMPOSE.split('\n').find((candidate) => /TRUST_PROXY=/.test(candidate));
  assert.ok(line, 'docker-compose.yml no longer sets TRUST_PROXY');
  // `${TRUST_PROXY:-1}` means the default is the part after `:-`, which is what
  // an operator gets when they set nothing.
  const value = line.split('TRUST_PROXY=')[1]?.trim() ?? '';
  const fallback = value.includes(':-') ? value.slice(value.indexOf(':-') + 2) : value;
  assert.notEqual(
    fallback.replace(/\W+$/, ''),
    'true',
    'docker-compose.yml defaults TRUST_PROXY to true, which lets a client pick its own rate-limit key',
  );
});

/**
 * The log cap of one service as `{ maxSize, maxFile }`, failing the test when
 * the service rotates nothing.
 *
 * @param {{ name: string; body: string }} service
 */
function logCap(service) {
  const logging = nestedBlock(service.body, 'logging');
  assert.ok(
    logging,
    `docker-compose.yml: service "${service.name}" sets no logging, so its json-file log never rotates`,
  );
  // Named, because a daemon whose default driver is another one would turn
  // the options down
  assert.match(
    logging,
    /^\s+driver:\s*json-file\s*$/m,
    `service "${service.name}": logging must name driver json-file`,
  );
  // Quoted: the options are strings to Docker, and a bare 5 is a YAML number
  const maxSize = /^\s+max-size:\s*'(\d+[km])'\s*$/m.exec(logging)?.[1];
  const maxFile = /^\s+max-file:\s*'(\d+)'\s*$/m.exec(logging)?.[1];
  assert.ok(maxSize, `service "${service.name}": logging needs a quoted max-size such as '10m'`);
  assert.ok(maxFile, `service "${service.name}": logging needs a quoted max-file such as '5'`);
  return { maxSize, maxFile };
}

test('every compose service caps its log', () => {
  const services = composeServices();
  assert.equal(services.length, 3, 'docker-compose.yml no longer lists the three expected services');
  for (const service of services) {
    logCap(service);
  }
});

test('the proxy leaves API requests out of its access log', () => {
  const api = nginxLocationOwn('/api/');
  assert.ok(api, 'client/nginx.conf.template has no `location /api/` block');
  // The server logs every API request already, without the query string a
  // line of nginx's would carry. Read from the location's own directives:
  // inside the cross-site `if` it would cover the 403s alone.
  assert.match(api, /^\s*access_log\s+off;/m, 'location /api/ must turn access_log off for every request it proxies');
});

test('the documented Elasticsearch docker run caps its log like the compose stack', () => {
  const elasticsearch = composeServices().find((service) => service.name === 'elasticsearch');
  assert.ok(elasticsearch, 'docker-compose.yml has no elasticsearch service');
  const { maxSize, maxFile } = logCap(elasticsearch);
  for (const doc of ['README.md', 'docs/INSTALL.md', 'docs/README.pl.md']) {
    const text = read(doc);
    const start = text.indexOf('docker run -d --name videodeck-elasticsearch');
    assert.notEqual(start, -1, `${doc} no longer documents the Elasticsearch docker run`);
    const end = text.indexOf('docker.elastic.co/elasticsearch/elasticsearch:', start);
    assert.notEqual(end, -1, `${doc}: the Elasticsearch docker run names no image`);
    const command = text.slice(start, end);
    // Named, as in the compose stack: a daemon whose default driver is
    // journald refuses both --log-opt flags, and the node never starts
    assert.match(
      command,
      /--log-driver[= ]json-file\s/,
      `${doc}: the docker run must name --log-driver json-file, the driver its --log-opt flags belong to`,
    );
    assert.match(
      command,
      new RegExp(`--log-opt max-size=${maxSize}\\s`),
      `${doc}: the docker run must cap its log at max-size=${maxSize}, as the compose stack does`,
    );
    assert.match(
      command,
      new RegExp(`--log-opt max-file=${maxFile}\\s`),
      `${doc}: the docker run must keep at most max-file=${maxFile} log files, as the compose stack does`,
    );
  }
});

/**
 * The instructions of a Dockerfile, continuation lines joined.
 *
 * @param {string} dockerfile
 */
function dockerfileLines(dockerfile) {
  return dockerfile.replace(/\\\n\s*/g, ' ').split('\n');
}

/**
 * Every HEALTHCHECK instruction of a Dockerfile, in every stage: the parser
 * reads them all before the first step runs.
 *
 * @param {string} dockerfile
 */
function healthchecksOf(dockerfile) {
  return dockerfileLines(dockerfile).filter((line) => /^HEALTHCHECK\s/.test(line));
}

/**
 * The HEALTHCHECK the image carries, or null when it carries none. Docker
 * keeps the last one of the final stage, so a later `HEALTHCHECK NONE` turns
 * an earlier probe off. A HEALTHCHECK of the build stage never reaches the
 * image: both final stages start from a public base, not from it.
 *
 * @param {string} dockerfile
 */
function healthcheckOf(dockerfile) {
  const lines = dockerfileLines(dockerfile);
  let finalStage = 0;
  for (const [index, line] of lines.entries()) {
    if (/^FROM\s/.test(line)) {
      finalStage = index;
    }
  }
  const last = lines
    .slice(finalStage)
    .filter((line) => /^HEALTHCHECK\s/.test(line))
    .at(-1);
  return last === undefined || /^HEALTHCHECK\s+NONE\b/.test(last) ? null : last;
}

/**
 * The option names a HEALTHCHECK passes before CMD or NONE, without the
 * leading dashes and the value: `--interval=30s` gives `interval`.
 *
 * @param {string} healthcheck
 */
function healthcheckOptions(healthcheck) {
  /** @type {string[]} */
  const options = [];
  for (const word of healthcheck.split(/\s+/).slice(1)) {
    if (!word.startsWith('--')) {
      break; // CMD or NONE: the options end here
    }
    options.push(word.slice(2).split('=')[0] ?? '');
  }
  return options;
}

test('every image healthcheck parses on Docker Engine 24', () => {
  // The Dockerfile parser in Engine 24 and older knows these four options and
  // refuses the whole file on any other, before the first step runs, so
  // `docker compose up --build` stops at "unknown flag: start-interval".
  // Synology's Container Manager and Debian 12's docker.io ship such engines.
  const engine24 = new Set(['interval', 'timeout', 'start-period', 'retries']);
  /** @type {[string, string][]} */
  const dockerfiles = [
    ['server/Dockerfile', SERVER_DOCKERFILE],
    ['client/Dockerfile', CLIENT_DOCKERFILE],
  ];
  for (const [name, dockerfile] of dockerfiles) {
    const healthchecks = healthchecksOf(dockerfile);
    assert.notEqual(healthchecks.length, 0, `${name} has no HEALTHCHECK`);
    for (const healthcheck of healthchecks) {
      const unknown = healthcheckOptions(healthcheck).filter((option) => !engine24.has(option));
      assert.deepEqual(
        unknown,
        [],
        `${name}: HEALTHCHECK --${unknown.join(', --')} fails the build on Docker Engine 24 and older, which know only --interval, --timeout, --start-period and --retries`,
      );
    }
  }
});

test('both images probe their liveness path, never a readiness one', () => {
  // /health and /api/health answer 503 while Elasticsearch is down, and the
  // server is alive then: its banner says so. /health/live asks the process.
  const server = healthcheckOf(SERVER_DOCKERFILE);
  assert.ok(server, 'the server image carries no HEALTHCHECK: none in the final stage, or HEALTHCHECK NONE last');
  assert.match(
    server,
    /'http:\/\/127\.0\.0\.1:'.*'\/health\/live'/,
    'the server HEALTHCHECK must ask 127.0.0.1 for /health/live',
  );
  // The client answers its own probe, so a server outage leaves the UI that
  // reports it healthy
  const client = healthcheckOf(CLIENT_DOCKERFILE);
  assert.ok(client, 'the client image carries no HEALTHCHECK: none in the final stage, or HEALTHCHECK NONE last');
  assert.match(
    client,
    /http:\/\/127\.0\.0\.1\/health\/live\b/,
    'the client HEALTHCHECK must ask nginx for /health/live',
  );
  // The location's own directives: inside an `if` they would cover only the
  // requests that branch takes
  const probe = nginxLocationOwn('= /health/live');
  assert.ok(probe, 'client/nginx.conf.template has no `location = /health/live` for the probe');
  assert.match(probe, /^\s*return\s+200\b/m, 'the probe location must answer by itself, without the upstream');
  assert.match(probe, /^\s*access_log\s+off;/m, 'the probe location must stay out of the access log');
});

test('the Elasticsearch healthcheck asks the cluster, not the root path', () => {
  const elasticsearch = composeServices().find((service) => service.name === 'elasticsearch');
  assert.ok(elasticsearch, 'docker-compose.yml has no elasticsearch service');
  // The server waits for this one (depends_on: service_healthy), and `/`
  // answers before the cluster accepts index work
  assert.match(
    elasticsearch.body,
    /_cluster\/health\?wait_for_status=yellow/,
    'the elasticsearch healthcheck must wait for a yellow cluster',
  );
});

test('no compose service turns an image healthcheck off', () => {
  for (const service of composeServices()) {
    assert.doesNotMatch(
      service.body,
      /^\s+disable:\s*true\b|\[\s*['"]NONE['"]\s*\]/m,
      `docker-compose.yml: service "${service.name}" switches its healthcheck off`,
    );
  }
});
