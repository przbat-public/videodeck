import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Options-page tests. The page is one form handler, so these tests boot the
 * real `main()` against a stubbed `chrome` API and a hand-built DOM (vitest
 * runs in the `node` environment) and then submit the form the way a user
 * does. `chrome.storage.local` is a real little key-value store, so the
 * assertions read the settings the user is left with, not a call sequence.
 */

type MockFn = ReturnType<typeof vi.fn>;

interface FakeElement {
  value: string;
  style: { display: string };
  className: string;
  textContent: string;
  addEventListener: MockFn;
}

interface StorageFake {
  state: Record<string, unknown>;
  local: { get: MockFn; set: MockFn; remove: MockFn };
}

function fakeElement(): FakeElement {
  return { value: '', style: { display: '' }, className: '', textContent: '', addEventListener: vi.fn() };
}

/** A store that answers `get` with the keys it holds and keeps every write. */
function createStorage(initial: Record<string, string>): StorageFake {
  const state: Record<string, unknown> = { ...initial };
  return {
    state,
    local: {
      get: vi.fn(async (keys: string[]) =>
        Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]])),
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(state, items);
      }),
      remove: vi.fn(async (key: string) => {
        delete state[key];
      }),
    },
  };
}

describe('options page', () => {
  const savedSettings = { serverUrl: 'http://localhost:3001', folderPath: '/videos', apiToken: 'old-token' };

  let storage: StorageFake;
  let serverUrlInput: FakeElement;
  let folderPathInput: FakeElement;
  let apiTokenInput: FakeElement;
  let statusElement: FakeElement;
  let submitHandler: ((event: { preventDefault: () => void }) => void) | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    vi.resetModules();
    submitHandler = undefined;
    storage = createStorage(savedSettings);

    serverUrlInput = fakeElement();
    folderPathInput = fakeElement();
    apiTokenInput = fakeElement();
    statusElement = fakeElement();

    const form = fakeElement();
    form.addEventListener = vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => {
      if (event === 'submit') {
        submitHandler = handler;
      }
    });

    const elements: Record<string, FakeElement> = {
      optionsForm: form,
      serverUrl: serverUrlInput,
      folderPath: folderPathInput,
      apiToken: apiTokenInput,
      testBtn: fakeElement(),
      status: statusElement,
    };

    vi.stubGlobal('chrome', {
      storage: { local: storage.local },
      permissions: { contains: vi.fn().mockResolvedValue(true), request: vi.fn().mockResolvedValue(true) },
      i18n: { getMessage: vi.fn((key: string) => key) },
    });
    vi.stubGlobal('document', {
      readyState: 'complete',
      getElementById: vi.fn((id: string) => elements[id] ?? null),
      querySelectorAll: vi.fn(() => []),
      addEventListener: vi.fn(),
    });

    await import('./options');
    await vi.waitFor(() => expect(submitHandler).toBeDefined());
  });

  /** Clicks the form's save button. */
  function submitForm(): void {
    if (submitHandler === undefined) {
      throw new Error('the options form did not register a submit handler');
    }
    submitHandler({ preventDefault: vi.fn() });
  }

  /** Lets the save chain (permission check → storage write) finish. */
  async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('loads the saved settings into the form', () => {
    expect(serverUrlInput.value).toBe(savedSettings.serverUrl);
    expect(folderPathInput.value).toBe(savedSettings.folderPath);
    expect(apiTokenInput.value).toBe(savedSettings.apiToken);
  });

  it('removes the stored API token when the field is cleared and the form is saved', async () => {
    apiTokenInput.value = '';

    submitForm();
    await flushAsyncWork();

    expect(storage.state.apiToken).toBeUndefined();
    expect(storage.state.serverUrl).toBe(savedSettings.serverUrl);
    expect(storage.state.folderPath).toBe(savedSettings.folderPath);
    expect(statusElement.textContent).toBe('settingsSaved');
  });

  it('stores an API token typed into the field', async () => {
    // A token is only accepted over https (saveSettings refuses to send it in
    // cleartext), so the user switched the server URL first.
    serverUrlInput.value = 'https://video.example.com';
    apiTokenInput.value = 'new-token';

    submitForm();
    await flushAsyncWork();

    expect(storage.state.apiToken).toBe('new-token');
    expect(storage.state.serverUrl).toBe('https://video.example.com');
  });
});
