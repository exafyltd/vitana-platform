import * as fs from 'fs';
import * as path from 'path';

/**
 * Duplicated logic from scripts/ci/dev-autopilot-scan.mjs
 * Inline to allow testing the skip condition without modifying the script's exports.
 */
function scanTodos(files: string[], repoRoot: string) {
  const signals: any[] = [];
  const regex = /(TODO|FIXME|HACK|XXX)\b/g;

  for (const file of files) {
    const ext = path.extname(file);
    if (!['.js', '.ts', '.mjs'].includes(ext)) continue;

    // Normalize path separators to POSIX for consistent checking across OSes
    const relPath = path.relative(repoRoot, file).split(path.sep).join(path.posix.sep);

    // The intended fix: Skip the scanner's own file
    if (relPath === 'scripts/ci/dev-autopilot-scan.mjs') continue;

    const content = fs.readFileSync(file, 'utf-8');
    let match;
    while ((match = regex.exec(content)) !== null) {
      signals.push({
        rule_id: 'todo-scanner-v1',
        file_path: relPath,
        severity: match[1] === 'FIXME' ? 'high' : 'low'
      });
    }
  }
  return signals;
}

describe('dev-autopilot-scan self-skip logic', () => {
  let readFileSyncSpy: jest.SpyInstance;

  beforeEach(() => {
    readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
      const fileStr = filePath.toString();
      // Simulate the scanner file containing the literal 'FIXME' in its logic
      if (fileStr.endsWith('dev-autopilot-scan.mjs')) {
        return `const severity = match[1] === 'FIXME' ? 'high' : 'low';`;
      }
      // Simulate another file with a real finding
      if (fileStr.endsWith('other.ts')) {
        return `// FIXME: resolve this technical debt`;
      }
      return '';
    });
  });

  afterEach(() => {
    readFileSyncSpy.mockRestore();
  });

  it('should ignore the scanner file even if it contains a FIXME literal', () => {
    const mockRepoRoot = path.join(__dirname, 'mock-repo');
    const scannerFilePath = path.join(mockRepoRoot, 'scripts', 'ci', 'dev-autopilot-scan.mjs');
    const otherFilePath = path.join(mockRepoRoot, 'src', 'other.ts');

    const files = [scannerFilePath, otherFilePath];
    const signals = scanTodos(files, mockRepoRoot);

    // Ensure the scanner caught the real finding
    expect(signals).toHaveLength(1);
    expect(signals[0].file_path).toBe('src/other.ts');
    
    // Ensure the scanner ignored its own file
    const selfSignal = signals.find(s => s.file_path === 'scripts/ci/dev-autopilot-scan.mjs');
    expect(selfSignal).toBeUndefined();
  });
});