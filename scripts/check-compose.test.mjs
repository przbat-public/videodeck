import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The compose file is the deployment most operators actually run, and nothing
// else in the gate reads it: a service without a restart policy stays down
// after a host reboot, and a proxy that forgets X-Forwarded-For turns the
// rate-limit key into a header the client picks. A log without a cap grows on
// the Docker disk, the one whose flood stage turns the index read-only. Each
// is cheap to state here and expensive to notice in production.
//
// Parsed by indentation instead of a YAML dependency: the file is ours, and a
// parser would be a dependency the gate has to keep alive.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string[]} */ ...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const COMPOSE = read('docker-compose.yml');
const NGINX_TEMPLATE = read('client', 'nginx.conf.template');

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
  const api = nginxLocation('/api/');
  assert.ok(api, 'client/nginx.conf.template has no `location /api/` block');
  // The server logs every API request already, without the query string a
  // line of nginx's would carry
  assert.match(api, /^\s*access_log\s+off;/m, 'location /api/ must turn access_log off');
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
