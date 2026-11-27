import type { RequestListener, Server } from 'node:http';
import { createServer } from 'node:http';
import request from 'supertest';

/**
 * Pins the bind every supertest call in the suite relies on. Supertest starts
 * its own server for an app and sends the request to 127.0.0.1. Up to 7.3.0
 * it bound that server to the `::` wildcard, and macOS gives a wildcard bind
 * a port that another process already holds on 127.0.0.1. The connection then
 * goes to the more specific bind, so a route that exists answered 404 from a
 * local tool on the shared port, failing a different test on every run.
 * Bound to 127.0.0.1 itself, the server never gets such a port.
 */

/** How many ports past the allocator's position the test takes */
const SQUATTED_PORTS = 40;

function listen(server: Server, port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server is not listening on a TCP port');
  }
  return address.port;
}

describe('supertest servers', () => {
  const squatters: Server[] = [];

  afterEach(async () => {
    await Promise.all(squatters.splice(0).map(close));
  });

  it('never share a port with a loopback listener of another process', async () => {
    // macOS hands out ephemeral ports in sequence. Read where the allocator
    // stands, then hold the ports right after it on 127.0.0.1 with servers
    // that answer 418, the way a local tool holds its own.
    const probe = createServer();
    await listen(probe, 0);
    const next = portOf(probe) + 1;
    await close(probe);
    for (let port = next; port < next + SQUATTED_PORTS && port <= 65_535; port += 1) {
      const squatter = createServer((_req, res) => {
        res.statusCode = 418;
        res.end();
      });
      if (await listen(squatter, port, '127.0.0.1')) {
        squatters.push(squatter);
      }
    }

    const app: RequestListener = (_req, res) => {
      res.end('ours');
    };
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toBe('ours');
  });
});
