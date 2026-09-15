import { MockOpenai } from '@videodeck/test-infra/mockOpenai';

/**
 * Pins the mock's test-controls surface: the prompt log, the mid-test
 * content override and the injected failure status.
 */
describe('MockOpenai controls', () => {
  let mock: MockOpenai;
  let baseUrl: string;

  beforeAll(async () => {
    mock = new MockOpenai();
    baseUrl = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  const completion = (model: string) =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
    });

  it('records prompts and serves the default content', async () => {
    const response = await completion('gpt-4o');
    expect(response.status).toBe(200);
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(data.choices[0]?.message.content).toBe('Fake summary.');
    expect(mock.requests.at(-1)).toEqual({ model: 'gpt-4o', prompt: 'hello' });
  });

  it('setContent overrides the assistant reply mid-test', async () => {
    mock.setContent('Overridden summary text.');
    const response = await completion('gpt-4o');
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(data.choices[0]?.message.content).toBe('Overridden summary text.');
  });

  it('failWithStatus answers with the injected status until cleared', async () => {
    mock.failWithStatus(500);
    expect((await completion('gpt-4o')).status).toBe(500);
    mock.clearFailure();
    expect((await completion('gpt-4o')).status).toBe(200);
  });
});
