import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory mock of the OpenAI REST surface the summary service uses
 * (POST /v1/chat/completions). Deep integration tests point `OPENAI_BASE_URL`
 * at it, so the REAL summary pipeline (budgets, fallback chain, retry-after,
 * caching) runs end-to-end without a network or an API key.
 */

export interface MockOpenaiCall {
  model: string;
  /** The user message — contains the delimited subtitles the service sent */
  prompt: string;
}

export interface MockOpenaiOptions {
  /** Content of the assistant choice (default: 'Fake summary.') */
  content?: string;
  /** Models that answer 429 with Retry-After: 1 (exercises the fallback chain) */
  rateLimitedModels?: string[];
}

export class MockOpenai {
  private server: Server | null = null;
  private readonly calls: MockOpenaiCall[] = [];
  private readonly rateLimited: Set<string>;

  constructor(private readonly options: MockOpenaiOptions = {}) {
    this.rateLimited = new Set(this.options.rateLimitedModels ?? []);
  }

  /** Every completion request received, in order (assertions on prompts) */
  get requests(): MockOpenaiCall[] {
    return [...this.calls];
  }

  /** Answer 429 for the given model from now on (exercises the fallback chain) */
  rateLimitModel(model: string): void {
    this.rateLimited.add(model);
  }

  clearRateLimits(): void {
    this.rateLimited.clear();
  }

  /** Start listening on an ephemeral port; resolves with the base URL (ends in /v1). */
  async start(): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
      model: string;
      messages: { role: string; content: string }[];
    };

    const prompt = body.messages.find((message) => message.role === 'user')?.content ?? '';
    this.calls.push({ model: body.model, prompt });

    if (this.rateLimited.has(body.model)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(
        JSON.stringify({
          error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: this.options.content ?? 'Fake summary.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    );
  }
}
