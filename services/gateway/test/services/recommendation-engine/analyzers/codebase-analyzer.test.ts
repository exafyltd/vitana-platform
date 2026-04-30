import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeCodebase } from '../../../../src/services/recommendation-engine/analyzers/codebase-analyzer';

describe('codebase-analyzer severity mapping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['TODO', 'medium'],
    ['FIXME', 'high'],
    ['HACK', 'high'],
    ['XXX', 'medium'],
  ])('should assign severity %s for type %s', async (type: string, expectedSeverity: string) => {
    // Create a single file with one comment of the given type
    const fileContent = `// ${type}: test comment`;
    const filePath = path.join(tmpDir, 'test.ts');
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['.'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    const signal = result.signals[0];
    expect(signal.type).toBe('todo');
    expect(signal.severity).toBe(expectedSeverity);
    expect(signal.file_path).toBe('test.ts');
  });

  it('should handle all four types simultaneously', async () => {
    // Create a file with all four types
    const lines = [
      '// TODO: first',
      '// FIXME: second',
      '// HACK: third',
      '// XXX: fourth',
    ];
    const fileContent = lines.join('\n');
    const filePath = path.join(tmpDir, 'all.ts');
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['.'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(4);

    const severityByType: Record<string, string> = {};
    for (const signal of result.signals) {
      // Extract type from message: "XXX: ..." -> "XXX"
      const prefix = signal.message.split(':')[0];
      severityByType[prefix] = signal.severity;
    }

    expect(severityByType['TODO']).toBe('medium');
    expect(severityByType['FIXME']).toBe('high');
    expect(severityByType['HACK']).toBe('high');
    expect(severityByType['XXX']).toBe('medium');
  });
});