import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The compose file is the deployment most operators actually run, and nothing
// else in the gate reads it: a service without a restart policy stays down
// after a host reboot, and a proxy that forgets X-Forwarded-For turns the
// rate-limit key into a header the client picks. Both are cheap to state here
// and expensive to notice in production.
//
// Parsed by indentation instead of a YAML dependency: the file is ours, and a
// parser would be a dependency the gate has to keep alive.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const NGINX_TEMPLATE = readFileSync(path.join(ROOT, 'client', 'nginx.conf.template'), 'utf8');

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
