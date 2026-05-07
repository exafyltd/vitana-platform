import { generateCodebaseFingerprint, CodebaseSignal } from './codebase-analyzer';

describe('generateCodebaseFingerprint', () => {
  it('returns a 16-character hexadecimal string', () => {
    const signal: CodebaseSignal = {
      type: 'todo',
      severity: 'medium',
      file_path: 'src/test.ts',
      line_number: 10,
      message: 'implement this functionality',
      suggested_action: 'implement the function',
    };

    const fingerprint = generateCodebaseFingerprint(signal);
    
    expect(typeof fingerprint).toBe('string');
    expect(fingerprint.length).toBe(16);
    expect(/^[0-9a-f]{16}$/i.test(fingerprint)).toBe(true);
  });

  it('produces deterministic fingerprints for identical inputs', () => {
    const signal: CodebaseSignal = {
      type: 'todo',
      severity: 'medium',
      file_path: 'src/test.ts',
      line_number: 10,
      message: 'implement this functionality',
      suggested_action: 'implement the function',
    };

    const fingerprint1 = generateCodebaseFingerprint(signal);
    const fingerprint2 = generateCodebaseFingerprint(signal);

    expect(fingerprint1).toBe(fingerprint2);
  });

  it('incorporates the file path and line number into the fingerprint', () => {
    const signal1: CodebaseSignal = {
      type: 'todo',
      severity: 'medium',
      file_path: 'src/test.ts',
      line_number: 10,
      message: 'implement this functionality',
      suggested_action: 'implement the function',
    };

    const signal2: CodebaseSignal = {
      ...signal1,
      line_number: 11,
    };

    const fingerprint1 = generateCodebaseFingerprint(signal1);
    const fingerprint2 = generateCodebaseFingerprint(signal2);

    expect(fingerprint1).not.toBe(fingerprint2);
  });

  it('handles signals without a line_number gracefully', () => {
    const signal1: CodebaseSignal = {
      type: 'missing_tests',
      severity: 'medium',
      file_path: 'src/app.ts',
      message: 'missing test suite',
      suggested_action: 'add test suite',
    };

    const signal2: CodebaseSignal = {
      ...signal1,
      line_number: 0,
    };

    const fingerprint1 = generateCodebaseFingerprint(signal1);
    const fingerprint2 = generateCodebaseFingerprint(signal2);

    // If line_number is undefined, generateCodebaseFingerprint defaults to 0
    expect(fingerprint1).toBe(fingerprint2);
  });
});