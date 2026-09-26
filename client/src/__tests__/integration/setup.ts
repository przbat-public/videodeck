// The shared test setup: jest-dom matchers, i18n, toast mock, jsdom
// polyfills (matchMedia included) and per-test cleanup.
import { beforeEach } from 'vitest';
import { resetElasticsearchState } from '../../utils/elasticsearchStatus';
import '../../test/setup';

// The Elasticsearch state is one module-level store for the whole app (the
// banner reads it, any 503 writes it) and a test file keeps its module
// registry, so the test that stops the fake cluster would otherwise leave the
// next test's banner up before anything failed.
beforeEach(() => {
  resetElasticsearchState();
});
