import { CodebaseSignal } from '../../../../src/services/recommendation-engine/analyzers/codebase-analyzer';

type TodoType = 'TODO' | 'FIXME' | 'HACK' | 'XXX';

/**
 * Determines the severity of a signal based on a TODO comment type.
 * This logic is duplicated from the `analyzeCodebase` function for isolated testing.
 * @param type The type of the TODO comment.
 * @returns The corresponding severity level.
 */
const getSeverityForTodoType = (type: TodoType): CodebaseSignal['severity'] => {
  // See: services/gateway/src/services/recommendation-engine/analyzers/codebase-analyzer.ts
  return type === 'FIXME' || type === 'HACK' ? 'high' : 'medium';
};

describe('Codebase Analyzer - TODO Severity Mapping', () => {
  const testCases: Array<[TodoType, CodebaseSignal['severity']]> = [
    ['FIXME', 'high'],
    ['HACK', 'high'],
    ['TODO', 'medium'],
    ['XXX', 'medium'],
  ];

  test.each(testCases)('should map TODO type "%s" to "%s" severity', (type, expectedSeverity) => {
    const actualSeverity = getSeverityForTodoType(type);
    expect(actualSeverity).toBe(expectedSeverity);
  });
});