/**
 * `scripts/ci/dev-autopilot-scan.mjs` runs `todo-scanner-v1` over the `scripts/`
 * tree, which includes the driver itself. Every literal marker in that file —
 * the alternation inside TODO_PATTERN and the comparison in the severity
 * ternary — therefore matched its own pattern and produced a permanent
 * `todo-scanner-v1` finding pointing back at the driver (two of them were
 * queued for auto-approval per
 * docs/validation/VTID-04237/outputs/eligible-findings.txt). The fix is two
 * things, and both are asserted here:
 *
 *   1. scanTodos skips the driver's own source (SELF_REL_PATH), matching the
 *      precedent in scripts/ci/scanners/voice-experience-scanner.mjs.
 *   2. The severity mapping FIXME/HACK → medium, TODO/XXX → low is unchanged
 *      and now documented in a comment beside the ternary.
 *
 * The assertions read the scanner's OWN source and lift its own regex, so they
 * cannot drift from what CI actually runs.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCANNER = path.resolve(__dirname, '../../../../scripts/ci/dev-autopilot-scan.mjs');
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const SCANNER_REL = 'scripts/ci/dev-autopilot-scan.mjs';

const src = fs.readFileSync(SCANNER, 'utf8');
const srcLines = src.split('\n');

/** Lift TODO_PATTERN out of the scanner rather than restating it here. */
function todoPattern(): RegExp {
  const m = /^const TODO_PATTERN = (.+);$/m.exec(src);
  if (!m) throw new Error('TODO_PATTERN not found in the scanner source');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)() as RegExp;
}

/** The scanner's own "is this worth a signal?" rule, applied to one line. */
function scanTodosWouldFlag(line: string): boolean {
  const m = line.match(todoPattern());
  return !!m && (m[2] || '').trim().length >= 3;
}

/** Lift the `severity:` ternary out of scanTodos() and evaluate it. */
function severityOf(marker: string): string {
  const line = srcLines.find((l) => /severity:\s*m\[1\]\s*===/.test(l));
  if (!line) throw new Error('severity ternary not found in the scanner source');
  const expr = /severity:\s*(.+?),?$/.exec(line.trim());
  if (!expr) throw new Error('severity ternary not parseable');
  const match = todoPattern().exec(`${marker}: something`);
  if (!match) throw new Error(`TODO_PATTERN did not match ${marker}`);
  // eslint-disable-next-line no-new-func
  const fn = new Function('m', `return ${expr[1]};`) as (m: RegExpExecArray) => string;
  return fn(match);
}

describe('dev-autopilot-scan.mjs docs/severity contract', () => {
  it('maps the actionable markers to medium and the informational ones to low', () => {
    expect(severityOf('FIXME')).toBe('medium');
    expect(severityOf('HACK')).toBe('medium');
    expect(severityOf('TODO')).toBe('low');
    expect(severityOf('XXX')).toBe('low');
  });

  it('documents the mapping in a comment beside the ternary', () => {
    const idx = srcLines.findIndex((l) => /severity:\s*m\[1\]\s*===/.test(l));
    expect(idx).toBeGreaterThan(-1);
    const above = srcLines.slice(Math.max(0, idx - 6), idx).join('\n');
    expect(above).toMatch(/severity mapping/i);
    expect(above).toMatch(/medium/);
    expect(above).toMatch(/low/);
  });
});

describe('dev-autopilot-scan.mjs does not flag itself', () => {
  it('keeps marker prose out of its own comments', () => {
    // The skip is the load-bearing fix; this is the belt-and-braces half. A
    // comment that reads like an unresolved marker (the `FIXME:` that sat next
    // to the severity ternary) is prose noise in a file the scanner walks, and
    // becomes a real finding again the moment the skip is narrowed or lost.
    const noisy = srcLines.filter(
      (l) => /^\s*(\/\/|\*|\/\*)/.test(l) && scanTodosWouldFlag(l),
    );
    expect(noisy).toEqual([]);
  });

  it('would flag its own source without the skip (the noise this closes)', () => {
    // Proves the skip is load-bearing rather than decorative: the driver's own
    // marker literals are real matches for its own pattern.
    const selfFlagged = srcLines.filter(scanTodosWouldFlag);
    expect(selfFlagged.length).toBeGreaterThan(0);
  });

  it('skips exactly its own source, before matching, inside scanTodos', () => {
    const declared = /^const SELF_REL_PATH = '([^']+)';$/m.exec(src)?.[1];
    expect(declared).toBe(SCANNER_REL);
    // The literal must name the file it lives in — otherwise the guard drifts
    // (rename/move the driver and the self-noise silently returns).
    expect(path.relative(REPO_ROOT, SCANNER).split(path.sep).join('/')).toBe(declared);

    const guardIdx = srcLines.findIndex((l) => l.includes('relFromRepoLocal(file) === SELF_REL_PATH'));
    const matchIdx = srcLines.findIndex((l) => l.includes('line.match(TODO_PATTERN)'));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(matchIdx).toBeGreaterThan(guardIdx);
    // …and the guard sits inside the TODO scanner, not some other scanner.
    const scanTodosIdx = srcLines.findIndex((l) => l.startsWith('function scanTodos('));
    const nextScannerIdx = srcLines.findIndex((l) => l.startsWith('function scanLargeFiles('));
    expect(scanTodosIdx).toBeGreaterThan(-1);
    expect(nextScannerIdx).toBeGreaterThan(scanTodosIdx);
    expect(guardIdx).toBeGreaterThan(scanTodosIdx);
    expect(guardIdx).toBeLessThan(nextScannerIdx);
  });
});
