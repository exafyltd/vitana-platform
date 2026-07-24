module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // The VTID-02696 quarantine list is gone: all 11 suites were repaired in
  // the Phase 1 sweep of docs/TEST_COVERAGE_PLAN.md (drifted mocks/assertions
  // updated to current behavior; one genuine src bug fixed in routes/memory.ts).
  // Do not re-add suites here without an entry in the plan's schedule table.
  testPathIgnorePatterns: [
    '/node_modules/',
  ],
  setupFilesAfterEnv: ['<rootDir>/test/__mocks__/setup-tests.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  forceExit: true,
  // ESM-only packages that Jest (CJS) cannot require untransformed.
  // htmlparser2@12+ (pulled in by sanitize-html@2.17) and its dep chain
  // ship `"type": "module"` with no CJS build. The (\.pnpm/)? alternative
  // keeps the allowlist working under pnpm's nested node_modules layout.
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm/)?(node-fetch|data-uri-to-buffer|fetch-blob|formdata-polyfill|htmlparser2|entities|domhandler|domutils|dom-serializer|domelementtype|leac|peberminta))',
  ],
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', {
      isolatedModules: true,
      tsconfig: { allowJs: true },
    }],
  },
};
