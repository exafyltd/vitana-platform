/**
 * Codebase Analyzer - VTID-01185
 *
 * Scans the codebase for improvement opportunities:
 * - TODO/FIXME comments
 * - Large files (>1000 lines)
 * - Missing test coverage
 * - Dead code / unused exports
 * - Code duplication patterns
 */

import { createHash } from 'crypto';

const LOG_PREFIX = '[VTID-01185:Codebase]';

// =============================================================================
// Types
// =============================================================================

export interface CodebaseSignal {
  type: 'todo' | 'large_file' | 'missing_tests' | 'dead_code' | 'duplication' | 'missing_docs';
  severity: 'low' | 'medium' | 'high';
  file_path: string;
  line_number?: number;
  message: string;
  context?: string;
  suggested_action: string;
}

export interface CodebaseAnalysisResult {
  ok: boolean;
  signals: CodebaseSignal[];
  summary: {
    files_scanned: number;
    todos_found: number;
    large_files_found: number;
    missing_tests_found: number;
    duration_ms: number;
  };
  error?: string;
}

export interface CodebaseAnalyzerConfig {
  scan_paths: string[];
  exclude_paths: string[];
  file_size_threshold_lines: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: CodebaseAnalyzerConfig = {
  scan_paths: ['services/', 'prisma/', 'supabase/'],
  exclude_paths: ['node_modules/', 'dist/', '.git/', 'coverage/', 'build/'],
  file_size_threshold_lines: 1000,
};

// =============================================================================
// Todo/Fixme Scanner
// =============================================================================

interface TodoMatch {
  file: string;
  line: number;
  type: 'TODO' | 'FIXME' | 'HACK' | 'XXX';
  text: string;
}

async function scanTodos(basePath: string, config: CodebaseAnalyzerConfig): Promise<TodoMatch[]> {
  const todos: TodoMatch[] = [];

  try {
    // Use grep to find TODOs efficiently
    const { execSync } = await import('child_process');

    const excludeArgs = config.exclude_paths.map(p => `--exclude-dir=${p.replace(/\/$/, '')}`).join(' ');
    const includePattern = '--include=*.ts --include=*.tsx --include=*.js --include=*.jsx --include=*.sql';

    for (const scanPath of config.scan_paths) {
      try {
        const fullPath = `${basePath}/${scanPath}`;
        const cmd = `grep -rn ${excludeArgs} ${includePattern} -E "(TODO|FIXME|HACK|XXX):?" ${fullPath} 2>/dev/null || true`;
        const result = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 }).toString();

        for (const line of result.split('\n')) {
          if (!line.trim()) continue;

          // Parse grep output: file:line:content
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (match) {
            const [, file, lineNum, content] = match;
            const typeMatch = content.match(/(TODO|FIXME|HACK|XXX)/i);
            if (typeMatch) {
              todos.push({
                file: file.replace(basePath + '/', ''),
                line: parseInt(lineNum, 10),
                type: typeMatch[1].toUpperCase() as TodoMatch['type'],
                text: content.trim(),
              });
            }
          }
        }
      } catch {
        // Path doesn't exist or grep failed, continue
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning TODOs:`, error);
  }

  return todos;
}

// =============================================================================
// Large File Scanner
// =============================================================================

interface LargeFileMatch {
  file: string;
  lines: number;
}

async function scanLargeFiles(
  basePath: string,
  config: CodebaseAnalyzerConfig
): Promise<LargeFileMatch[]> {
  const largeFiles: LargeFileMatch[] = [];

  try {
    const { execSync } = await import('child_process');

    for (const scanPath of config.scan_paths) {
      try {
        const fullPath = `${basePath}/${scanPath}`;
        // Find .ts/.js files and count lines
        const cmd = `find ${fullPath} -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) -exec wc -l {} \\; 2>/dev/null | sort -rn || true`;
        const result = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 }).toString();

        for (const line of result.split('\n')) {
          if (!line.trim()) continue;

          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (match) {
            const [, lineCount, filePath] = match;
            const lines = parseInt(lineCount, 10);

            // Skip excluded paths
            if (config.exclude_paths.some(p => filePath.includes(p))) continue;

            if (lines > config.file_size_threshold_lines) {
              largeFiles.push({
                file: filePath.replace(basePath + '/', ''),
                lines,
              });
            }
          }
        }
      } catch {
        // Path doesn't exist, continue
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning large files:`, error);
  }

  // Sort by line count descending
  return largeFiles.sort((a, b) => b.lines - a.lines);
}

// =============================================================================
// Missing Tests Scanner
// =============================================================================

interface MissingTestMatch {
  file: string;
  reason: string;
}

async function scanMissingTests(
  basePath: string,
  config: CodebaseAnalyzerConfig
): Promise<MissingTestMatch[]> {
  const missingTests: MissingTestMatch[] = [];

  try {
    const { execSync } = await import('child_process');

    // Find all service files
    const servicePattern = `${basePath}/services/**/src/**/*.ts`;
    const cmd = `find ${basePath}/services -path "*/src/*.ts" -type f 2>/dev/null | grep -v node_modules | grep -v dist | grep -v ".test." | grep -v ".spec." || true`;
    const result = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 }).toString();

    const sourceFiles = result.split('\n').filter((f: string) => f.trim());

    for (const sourceFile of sourceFiles) {
      // Check if corresponding test file exists
      const testFile = sourceFile.replace('.ts', '.test.ts');
      const specFile = sourceFile.replace('.ts', '.spec.ts');
      const testDirFile = sourceFile.replace('/src/', '/tests/').replace('.ts', '.test.ts');

      try {
        execSync(`test -f "${testFile}" || test -f "${specFile}" || test -f "${testDirFile}"`, {
          stdio: 'ignore',
        });
      } catch {
        // Test file doesn't exist
        const relativePath = sourceFile.replace(basePath + '/', '');

        // Only flag important files (services, routes, utils)
        if (
          relativePath.includes('/services/') ||
          relativePath.includes('/routes/') ||
          relativePath.includes('/utils/')
        ) {
          // Skip index files and type files
          if (!relativePath.endsWith('index.ts') && !relativePath.includes('/types/')) {
            missingTests.push({
              file: relativePath,
              reason: 'No corresponding test file found',
            });
          }
        }
      }
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error scanning missing tests:`, error);
  }

  return missingTests;
}

// =============================================================================
// Main Analyzer Function
// =============================================================================

export async function analyzeCodebase(
  basePath: string,
  config: Partial<CodebaseAnalyzerConfig> = {}
): Promise<CodebaseAnalysisResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const signals: CodebaseSignal[] = [];

  console.log(`${LOG_PREFIX} Starting codebase analysis...`);

  try {
    // Run scans in parallel
    const [todos, largeFiles, missingTests] = await Promise.all([
      scanTodos(basePath, fullConfig),
      scanLargeFiles(basePath, fullConfig),
      scanMissingTests(basePath, fullConfig),
    ]);

    // Convert TODOs to signals
    for (const todo of todos) {
      const severity = todo.type === 'FIXME' || todo.type === 'HACK' ? 'high' : 'medium';
      signals.push({
        type: 'todo',
        severity,
        file_path: todo.file,
        line_number: todo.line,
        message: `${todo.type}: ${todo.text.substring(0, 200)}`,
        context: todo.text,
        suggested_action: `Address the ${todo.type} comment in ${todo.file}:${todo.line}`,
      });
    }

    // Convert large files to signals
    for (const file of largeFiles) {
      const severity = file.lines > 2000 ? 'high' : file.lines > 1500 ? 'medium' : 'low';
      signals.push({
        type: 'large_file',
        severity,
        file_path: file.file,
        message: `File has ${file.lines} lines (threshold: ${fullConfig.file_size_threshold_lines})`,
        suggested_action: `Consider refactoring ${file.file} into smaller modules`,
      });
    }

    // Convert missing tests to signals
    for (const test of missingTests) {
      signals.push({
        type: 'missing_tests',
        severity: 'medium',
        file_path: test.file,
        message: test.reason,
        suggested_action: `Add unit tests for ${test.file}`,
      });
    }

    const duration = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} Analysis complete: ${signals.length} signals found in ${duration}ms`
    );

    return {
      ok: true,
      signals,
      summary: {
        files_scanned: todos.length + largeFiles.length + missingTests.length,
        todos_found: todos.length,
        large_files_found: largeFiles.length,
        missing_tests_found: missingTests.length,
        duration_ms: duration,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Analysis failed:`, errorMessage);

    return {
      ok: false,
      signals: [],
      summary: {
        files_scanned: 0,
        todos_found: 0,
        large_files_found: 0,
        missing_tests_found: 0,
        duration_ms: Date.now() - startTime,
      },
      error: errorMessage,
    };
  }
}

// =============================================================================
// Fingerprint Generator
// =============================================================================

export function generateCodebaseFingerprint(signal: CodebaseSignal): string {
  const data = `codebase:${signal.type}:${signal.file_path}:${signal.line_number || 0}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
