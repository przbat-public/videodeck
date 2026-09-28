import http from 'node:http';
import path from 'node:path';
import type { LibraryEvent, StatusResponse } from '@videodeck/shared/api';
import { libraryEventSchema } from '@videodeck/shared/schemas';
import type { DeepServerTestEnv } from '@videodeck/test-infra/deepServerTestEnv';
import { createDeepServerTestEnv, folderConfig } from '@videodeck/test-infra/deepServerTestEnv';
import { activeSseStreamCount } from '../utils/sseRegistry';

/**
 * GET /api/events over a REAL socket, because this is the connection a page
 * holds open for a whole session: supertest cannot show it, since the response
 * never ends on its own. The tests read frames off a live socket the way the
 * browser does, create a channel folder underneath the running server and read
 * the frame that change produces.
 *
 * The stream is driven by the real watcher, so the wait is for a filesystem
 * event plus the 300 ms debounce, never for a fixed delay.
 */

/** Frame budget: the watcher debounce plus the reconcile and the write */
const FRAME_BUDGET_MS = 8_000;

/** Poll step for a frame only a filesystem event can produce */
const FRAME_POLL_MS = 25;

interface LibraryStream {
  /** Frames in arrival order */
  readonly frames: LibraryEvent[];
  /** The frame at `index`, waiting until the budget runs out */
  at(index: number): Promise<LibraryEvent>;
  /** Tear the socket down without reading it out, like a tab closing */
  destroy(): void;
}

/** One decoded `data:` payload as an event; null for a line that is not one */
function parseFrame(raw: string): LibraryEvent | null {
  try {
    const parsed = libraryEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A poll step inside a named helper: the budget is the failure mode */
function nextPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));
}

/**
 * Open GET /api/events and collect what it sends. The first frame arrives on
 * connect, so `at(0)` resolves without a library change.
 */
async function openLibraryStream(env: DeepServerTestEnv): Promise<LibraryStream> {
  const frames: LibraryEvent[] = [];
  let buffer = '';
  const request = http.request(`${String(env.baseUrl)}/api/events`, { method: 'GET' });
  const response = new Promise<http.IncomingMessage>((resolve) => request.once('response', resolve));
  request.end();
  const socket = await response;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const raw = line.startsWith('data: ') ? line.slice('data: '.length) : '';
      const frame = raw.length > 0 ? parseFrame(raw) : null;
      if (frame !== null) {
        frames.push(frame);
      }
    }
  });

  return {
    frames,
    async at(index: number): Promise<LibraryEvent> {
      const deadline = Date.now() + FRAME_BUDGET_MS;
      while (Date.now() < deadline) {
        const frame = frames[index];
        if (frame !== undefined) {
          return frame;
        }
        await nextPoll();
      }
      throw new Error(`Frame ${index} never arrived within ${FRAME_BUDGET_MS} ms; read ${JSON.stringify(frames)}`);
    },
    destroy(): void {
      socket.destroy();
      request.destroy();
    },
  };
}

/** GET /metrics until it reports the given number of open streams */
async function waitForOpenStreams(env: DeepServerTestEnv, expected: number): Promise<void> {
  const deadline = Date.now() + FRAME_BUDGET_MS;
  let body = '';
  while (Date.now() < deadline) {
    body = (await env.agent.get('/metrics').expect(200)).text;
    if (body.includes(`sse_streams_open ${expected}`)) {
      return;
    }
    await nextPoll();
  }
  throw new Error(`sse_streams_open never reached ${expected}; last body:\n${body}`);
}

/**
 * Point the library at every folder under `videos/`, the shape a swappable
 * drive produces. A single literal path would leave a folder created next to
 * it outside the watch, which is exactly what these tests create.
 */
function watchSiblings(env: DeepServerTestEnv): void {
  process.env.VIDEOS_FOLDER_PATH = path.join(env.videosDir, '*');
}

/**
 * GET /api/status until the library reports the folder. Seeding a folder and
 * opening a stream in the same tick would race the 300 ms watcher debounce, and
 * the opening frame would then describe a library the test already changed.
 */
async function waitForFolder(env: DeepServerTestEnv, folderPath: string): Promise<void> {
  const deadline = Date.now() + FRAME_BUDGET_MS;
  let folders: string[] = [];
  while (Date.now() < deadline) {
    const status = await env.agent.get('/api/status').expect(200);
    folders = (status.body as StatusResponse).videosFolderPath;
    if (folders.includes(folderPath)) {
      return;
    }
    await nextPoll();
  }
  throw new Error(`${folderPath} never reached the library; last read ${JSON.stringify(folders)}`);
}

describe('GET /api/events', () => {
  let env: DeepServerTestEnv;

  beforeAll(async () => {
    env = await createDeepServerTestEnv({ listen: true });
  });

  afterAll(async () => {
    await env.dispose();
  });

  afterEach(async () => {
    // Every test owns its socket; one that leaks would poison the next test
    await waitForOpenStreams(env, 0);
  });

  it('the first frame carries the current revision and folders', async () => {
    const folderPath = await env.seedFolder('events-first', { 'config.json': folderConfig() });
    watchSiblings(env);
    await waitForFolder(env, folderPath);
    const stream = await openLibraryStream(env);

    try {
      const frame = await stream.at(0);

      expect(frame.type).toBe('library');
      expect(frame.folders).toContain(folderPath);
      expect(Number.isInteger(frame.revision)).toBe(true);
      expect(frame.revision).toBeGreaterThan(0);
      // The folder the frame reports is not also reported as missing
      expect(frame.unavailable).not.toContain(folderPath);
      // Nothing precedes the opening frame, so there is no difference to report
      expect(frame.added).toBeUndefined();
      expect(frame.removed).toBeUndefined();
    } finally {
      stream.destroy();
    }
  });

  it('a folder that appears while the stream is open arrives as one frame with added and removed', async () => {
    const existing = await env.seedFolder('events-before', { 'config.json': folderConfig() });
    watchSiblings(env);
    await waitForFolder(env, existing);
    const stream = await openLibraryStream(env);

    try {
      const opening = await stream.at(0);

      const added = await env.seedFolder('events-after', { 'config.json': folderConfig() });

      const frame = await stream.at(1);
      expect(frame.folders).toContain(existing);
      expect(frame.folders).toContain(added);
      expect(frame.added).toEqual([added]);
      expect(frame.removed).toEqual([]);
      expect(frame.revision).toBeGreaterThan(opening.revision);
    } finally {
      stream.destroy();
    }
  });

  it('an aborted stream releases its slot in the sse registry', async () => {
    const stream = await openLibraryStream(env);
    await stream.at(0);
    await waitForOpenStreams(env, 1);
    expect(activeSseStreamCount()).toBe(1);

    stream.destroy();

    await waitForOpenStreams(env, 0);
    expect(activeSseStreamCount()).toBe(0);
  });
});
