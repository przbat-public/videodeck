/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules must not import each other in a cycle.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-is-leaf',
      severity: 'error',
      comment: 'shared/ is a leaf module: it may not import from any application package.',
      from: { path: '^shared/' },
      to: { path: '^(server|client|chrome-extension|test-infra)/', pathNot: '^shared/' },
    },
    {
      name: 'no-cross-app-imports-server',
      severity: 'error',
      comment: 'server/ may only import from itself and shared/.',
      from: { path: '^server/' },
      to: { path: '^(client|chrome-extension)/' },
    },
    {
      name: 'no-cross-app-imports-client',
      severity: 'error',
      comment: 'client/ may only import from itself and shared/.',
      from: { path: '^client/' },
      to: { path: '^(server|chrome-extension)/' },
    },
    {
      name: 'no-cross-app-imports-extension',
      severity: 'error',
      comment: 'chrome-extension/ may only import from itself and shared/.',
      from: { path: '^chrome-extension/' },
      to: { path: '^(server|client)/' },
    },
    {
      name: 'test-infra-is-not-an-app',
      severity: 'error',
      comment: 'test-infra/ knows the server it tests, but never the UIs.',
      from: { path: '^test-infra/' },
      to: { path: '^(client|chrome-extension)/' },
    },
    {
      name: 'apps-do-not-import-test-infra-in-production',
      severity: 'error',
      comment: 'Only test files may pull in the shared test infrastructure.',
      from: { path: '^(server|client)/', pathNot: '(__tests__|\\.test\\.|\\.spec\\.)' },
      to: { path: '^test-infra/' },
    },
  ],
  options: {
    // Follow the workspace packages through their node_modules symlinks (the
    // rules above must keep seeing the real graph); ignore everything else.
    doNotFollow: { path: 'node_modules\\/(?!@videodeck\\/)' },
    // Resolve the workspace packages through their package.json exports.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'types', 'import', 'node', 'default'],
    },
    // Generated/build output is never part of the dependency graph.
    exclude: ['(^|/)(dist|coverage|test-results)/'],
    // Resolve `@shared/*` via each package's tsconfig paths.
    tsPreCompilationDeps: true,
  },
};
