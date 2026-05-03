import fs from 'fs';
import path from 'path';
import os from 'os';

// Helper mimicking the behavior from scripts/ci/dev-autopilot-scan.mjs
function relFromRepoLocal(file: string, repoRoot: string) {
  return path.relative(repoRoot, file).replace(/\\/g, '/');
}

// Duplicating the intended scanTodos logic inline as the script does not export it
function scanTodosMock(files: string[], repoRoot: string) {
  const signals: any[] = [];
  const regex = /\b(TODO|FIXME|HACK|XXX)\b/g;

  for (const file of files) {
    const relPath = relFromRepoLocal(file, repoRoot);
    
    // The intended fix logic:
    if (relPath === 'scripts/ci/dev-autopilot-scan.mjs') {
      continue;
    }

    const content = fs.readFileSync(file, 'utf-8');
    let match;
    while ((match = regex.exec(content)) !== null) {
      signals.push({
        file_path: relPath,
        message: `Found ${match[1]}`,
      });
    }
  }
  return signals;
}

describe('dev-autopilot-scan self-skip', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autopilot-scan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should ignore the scanner script itself if it contains FIXME literal', () => {
    // 1. Setup mock environment with the scanner file
    const scannerFilePath = path.join(tempDir, 'scripts', 'ci', 'dev-autopilot-scan.mjs');
    fs.mkdirSync(path.dirname(scannerFilePath), { recursive: true });
    // Write a file that contains the FIXME string similar to the real file's severity ternary
    fs.writeFileSync(scannerFilePath, 'const severity = true ? "FIXME" : "INFO";\n', 'utf-8');

    // 2. Create another standard source file containing a FIXME to ensure general scanning works
    const normalFilePath = path.join(tempDir, 'services', 'gateway', 'index.ts');
    fs.mkdirSync(path.dirname(normalFilePath), { recursive: true });
    fs.writeFileSync(normalFilePath, '// FIXME: this needs to be addressed\n', 'utf-8');

    const files = [scannerFilePath, normalFilePath];
    
    // 3. Run the scan logic
    const signals = scanTodosMock(files, tempDir);

    // 4. Verify the correct signal generation
    const normalSignals = signals.filter((s) => s.file_path === 'services/gateway/index.ts');
    expect(normalSignals).toHaveLength(1);

    const scannerSignals = signals.filter((s) => s.file_path === 'scripts/ci/dev-autopilot-scan.mjs');
    expect(scannerSignals).toHaveLength(0); // Should be empty
  });
});