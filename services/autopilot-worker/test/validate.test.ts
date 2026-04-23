/**
 * Unit tests for the tsc output filter. We don't actually run tsc here
 * (the clone + validator integration is covered by the end-to-end smoke
 * test); this file just locks the diagnostic-line filter so we don't
 * accidentally start passing through unrelated pre-existing main errors
 * as "your retry must fix these".
 */

import { filterErrorsToChangedFiles, parseJestReport, extractJestFailures } from '../src/validate';

describe('filterErrorsToChangedFiles', () => {
  it('keeps errors that reference a changed file, drops the rest', () => {
    const raw = [
      'services/gateway/src/routes/tasks.test.ts(21,27): error TS2307: Cannot find module \'../src/routes/tasks\'',
      'services/gateway/src/services/unrelated.ts(10,5): error TS2304: Cannot find name bar.',
      'services/gateway/src/routes/tasks.test.ts(43,1): error TS2540: Cannot assign.',
    ].join('\n');
    const out = filterErrorsToChangedFiles(raw, new Set([
      'services/gateway/src/routes/tasks.test.ts',
    ]));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('tasks.test.ts(21,27)');
    expect(out[1]).toContain('tasks.test.ts(43,1)');
  });

  it('includes continuation lines belonging to a kept diagnostic', () => {
    const raw = [
      'services/gateway/src/routes/foo.ts(5,1): error TS2322: Type \'string\' not assignable to',
      '  Type \'number\'.',
      '  (overload continuation…)',
      'services/gateway/src/services/bar.ts(3,1): error TS2304: Cannot find name baz.',
    ].join('\n');
    const out = filterErrorsToChangedFiles(raw, new Set([
      'services/gateway/src/routes/foo.ts',
    ]));
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('foo.ts');
    expect(out[1].trim()).toBe("Type 'number'.");
    expect(out[2]).toContain('overload continuation');
  });

  it('returns an empty array when no changed-file errors appear', () => {
    const raw = 'services/gateway/src/services/unchanged.ts(10,5): error TS2304: Bla.';
    const out = filterErrorsToChangedFiles(raw, new Set(['services/gateway/src/routes/new.test.ts']));
    expect(out).toEqual([]);
  });

  it('handles Windows-style backslash paths by normalising to forward slashes', () => {
    const raw = 'services\\gateway\\src\\routes\\tasks.test.ts(21,27): error TS2307: X';
    const out = filterErrorsToChangedFiles(raw, new Set([
      'services/gateway/src/routes/tasks.test.ts',
    ]));
    expect(out).toHaveLength(1);
  });
});

describe('parseJestReport', () => {
  it('parses a clean json report', () => {
    const report = {
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      testResults: [{ name: 'foo.test.ts', testResults: [] }],
    };
    const out = parseJestReport(JSON.stringify(report));
    expect(out).not.toBeNull();
    expect(out!.numTotalTests).toBe(3);
  });

  it('strips leading non-JSON noise (setup loader logs etc.)', () => {
    const report = { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] };
    const stdout = '✅ Test setup loaded - fetch mocked, env vars set\n' + JSON.stringify(report);
    const out = parseJestReport(stdout);
    expect(out).not.toBeNull();
    expect(out!.numTotalTests).toBe(1);
  });

  it('returns null when stdout has no parseable JSON', () => {
    expect(parseJestReport('jest crashed: cannot find module')).toBeNull();
  });
});

describe('extractJestFailures', () => {
  it('returns empty array when no tests failed', () => {
    const report = {
      numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
      testResults: [{
        name: 'a.test.ts',
        testResults: [
          { ancestorTitles: ['Suite'], title: 'works', status: 'passed', failureMessages: [] },
          { ancestorTitles: ['Suite'], title: 'also works', status: 'passed', failureMessages: [] },
        ],
      }],
    };
    expect(extractJestFailures(report)).toEqual([]);
  });

  it('extracts failure name + first 5 lines of failure message per failed test', () => {
    const report = {
      testResults: [{
        name: 'memory.test.ts',
        testResults: [
          {
            ancestorTitles: ['GET /api/v1/memory', 'when query missing'],
            title: 'returns 400',
            status: 'failed',
            failureMessages: [
              'Expected: 400\nReceived: 500\n  at line 42\n  at line 50\n  at line 60\n  at line 70\n  at line 80',
            ],
          },
        ],
      }],
    };
    const out = extractJestFailures(report);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('GET /api/v1/memory > when query missing > returns 400');
    expect(out[0]).toContain('Expected: 400');
    expect(out[0]).toContain('Received: 500');
    // Should NOT include the 6th line (capped at 5)
    expect(out[0]).not.toContain('at line 80');
  });

  it('handles multiple failed tests across multiple suites', () => {
    const report = {
      testResults: [
        { name: 'a.test.ts', testResults: [{ ancestorTitles: ['A'], title: 'fails', status: 'failed', failureMessages: ['boom'] }] },
        { name: 'b.test.ts', testResults: [{ ancestorTitles: ['B'], title: 'also fails', status: 'failed', failureMessages: ['bang'] }] },
      ],
    };
    expect(extractJestFailures(report)).toHaveLength(2);
  });
});
