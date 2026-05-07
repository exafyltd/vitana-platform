import { generateCodebaseFingerprint, CodebaseSignal } from './codebase-analyzer';

describe('Codebase Analyzer', () => {
  describe('generateCodebaseFingerprint', () => {
    it('should return a 16-character hexadecimal string', () => {
      const dummySignal: CodebaseSignal = {
        type: 'todo',
        severity: 'high',
        file_path: 'src/test.ts',
        line_number: 10,
        message: 'Test message',
        suggested_action: 'Test action'
      };

      const fingerprint = generateCodebaseFingerprint(dummySignal);
      
      expect(typeof fingerprint).toBe('string');
      expect(fingerprint).toHaveLength(16);
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should consistently produce the exact same fingerprint for identical inputs', () => {
      const signalA: CodebaseSignal = {
        type: 'large_file',
        severity: 'medium',
        file_path: 'src/components/App.tsx',
        line_number: undefined,
        message: 'File is too large',
        suggested_action: 'Refactor code'
      };
      
      const signalB: CodebaseSignal = {
        type: 'large_file',
        severity: 'medium',
        file_path: 'src/components/App.tsx',
        line_number: undefined,
        message: 'File is too large',
        suggested_action: 'Refactor code'
      };

      const fingerprintA = generateCodebaseFingerprint(signalA);
      const fingerprintB = generateCodebaseFingerprint(signalB);
      
      expect(fingerprintA).toBe(fingerprintB);
    });

    it('should produce different fingerprints for different file paths', () => {
      const signalA: CodebaseSignal = {
        type: 'missing_tests',
        severity: 'medium',
        file_path: 'src/utils/math.ts',
        message: 'Missing test file',
        suggested_action: 'Add tests'
      };

      const signalB: CodebaseSignal = {
        type: 'missing_tests',
        severity: 'medium',
        file_path: 'src/utils/string.ts',
        message: 'Missing test file',
        suggested_action: 'Add tests'
      };

      const fingerprintA = generateCodebaseFingerprint(signalA);
      const fingerprintB = generateCodebaseFingerprint(signalB);
      
      expect(fingerprintA).not.toBe(fingerprintB);
    });
  });
});