// The shared test setup: jest-dom matchers, i18n, toast mock, jsdom
// polyfills (matchMedia included) and per-test cleanup.
import { beforeEach } from 'vitest';
import { resetElasticsearchState } from '../../utils/elasticsearchStatus';
import { resetServerState } from './test-env';
import '../../test/setup';

// The Elasticsearch state is one module-level store for the whole app (the
// banner reads it, any 503 writes it) and a test file keeps its module
// registry, so the test that stops the fake cluster would otherwise leave the
// next test's banner up before anything failed. The mirror image lives in the
// in-process server: its own module-level caches outlive a test too, so both
// halves are dropped here rather than in whichever test happened to write.
beforeEach(async () => {
  resetElasticsearchState();
  await resetServerState();
});
