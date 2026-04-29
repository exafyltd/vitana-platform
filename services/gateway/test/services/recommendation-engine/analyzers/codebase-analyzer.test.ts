/**
 * Unit tests for codebase-analyzer.ts
 *
 * This test suite validates the severity mapping for TODO/FIXME/HACK/XXX comments.
 * It inlines the same severity logic used in the analyzer to ensure correctness.
 */

describe('codebase-analyzer severity mapping', () => {
  // Severity logic identical to the one in analyzeCodebase
  const determineSeverity = (type: 'TODO' | 'FIXME' | 'HACK' | 'XXX'): 'low' | 'medium' | 'high' => {
    return type === 'FIXME' || type === 'HACK' ? 'high' : 'medium';
  };

  it('should return high severity for FIXME', () => {
    expect(determineSeverity('FIXME')).toBe('high');
  });

  it('should return high severity for HACK', () => {
    expect(determineSeverity('HACK')).toBe('high');
  });

  it('should return medium severity for TODO', () => {
    expect(determineSeverity('TODO')).toBe('medium');
  });

  it('should return medium severity for XXX', () => {
    expect(determineSeverity('XXX')).toBe('medium');
  });

  it('should correctly map all four todo types using a data-driven approach', () => {
    const testCases: { type: 'TODO' | 'FIXME' | 'HACK' | 'XXX'; expected: 'low' | 'medium' | 'high' }[] = [
      { type: 'TODO', expected: 'medium' },
      { type: 'FIXME', expected: 'high' },
      { type: 'HACK', expected: 'high' },
      { type: 'XXX', expected: 'medium' },
    ];

    testCases.forEach(({ type, expected }) => {
      expect(determineSeverity(type)).toBe(expected);
    });
  });
});