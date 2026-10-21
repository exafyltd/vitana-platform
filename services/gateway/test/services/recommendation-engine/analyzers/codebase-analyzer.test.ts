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
    // Create a single file with one comment of the given type.
    // Use a subdirectory scan path (like the production defaults `services/`
    // etc.) — the analyzer strips `basePath/` off grep output, so paths are
    // reported relative to basePath, prefixed by the scan path.
    const fileContent = `// ${type}: test comment`;
    fs.mkdirSync(path.join(tmpDir, 'src'));
    const filePath = path.join(tmpDir, 'src', 'test.ts');
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['src/'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    const signal = result.signals[0];
    expect(signal.type).toBe('todo');
    expect(signal.severity).toBe(expectedSeverity);
    expect(signal.file_path).toBe('src/test.ts');
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

  it('does not flag its own detection-pattern source as a TODO (VTID-04275)', async () => {
    // The analyzer's own real file, on the live path a grep sweep over
    // services/ would report, containing a line that legitimately matches
    // the TODO_PATTERN (a string comparison against 'FIXME', not a real
    // comment) — the exact shape that produced a phantom finding live.
    const selfPath = path.join(
      tmpDir,
      'services',
      'gateway',
      'src',
      'services',
      'recommendation-engine',
      'analyzers',
      'codebase-analyzer.ts',
    );
    fs.mkdirSync(path.dirname(selfPath), { recursive: true });
    fs.writeFileSync(
      selfPath,
      `const severity = todo.type === 'FIXME' || todo.type === 'HACK' ? 'high' : 'medium';\n`,
      'utf-8',
    );

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['services/'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(0);
  });

  it('still flags a genuine TODO in a sibling analyzer file (VTID-04275)', async () => {
    // The self-match exclusion must be scoped to the one file — a real
    // TODO living next to it must still be caught.
    const siblingPath = path.join(
      tmpDir,
      'services',
      'gateway',
      'src',
      'services',
      'recommendation-engine',
      'analyzers',
      'other-analyzer.ts',
    );
    fs.mkdirSync(path.dirname(siblingPath), { recursive: true });
    fs.writeFileSync(siblingPath, '// TODO: implement this for real\n', 'utf-8');

    const result = await analyzeCodebase(tmpDir, {
      scan_paths: ['services/'],
      exclude_paths: [],
      file_size_threshold_lines: 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].file_path).toBe(
      'services/gateway/src/services/recommendation-engine/analyzers/other-analyzer.ts',
    );
  });
});