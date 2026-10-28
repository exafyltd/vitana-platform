/**
 * VTID-04108 — structural lock-in for WHERE the wider manual-activation
 * allowlist is (and, just as importantly, is NOT) wired in
 * dev-autopilot-execute.ts and routes/autopilot-recommendations.ts.
 *
 * Same extractFunctionBody helper as
 * test/autopilot-source-type-filter-call-sites.test.ts — pure-string
 * assertions against the source file, no runtime needed.
 */

import fs from 'fs';
import path from 'path';

const EXEC_FILE = path.resolve(
  __dirname,
  '../src/services/dev-autopilot-execute.ts',
);
const execSource = fs.readFileSync(EXEC_FILE, 'utf8');

const ROUTE_FILE = path.resolve(
  __dirname,
  '../src/routes/autopilot-recommendations.ts',
);
const routeSource = fs.readFileSync(ROUTE_FILE, 'utf8');

describe('bridgeActivationToExecution — uses the wider manual allowlist, and only it', () => {
  const fn = extractFunctionBody(execSource, 'bridgeActivationToExecution');

  it('gates its own source_type check on isManuallyBridgeableSourceType, not isExecutableSourceType', () => {
    expect(fn).toMatch(/isManuallyBridgeableSourceType\(rec\.source_type\)/);
    expect(fn).not.toMatch(/if \(!isExecutableSourceType\(rec\.source_type\)\)/);
  });

  it('passes allowManualSourceTypes: true to approveAutoExecute', () => {
    const approveCallIdx = fn.indexOf('await approveAutoExecute({');
    expect(approveCallIdx).toBeGreaterThan(-1);
    const approveCall = fn.slice(approveCallIdx, fn.indexOf('});', approveCallIdx) + 3);
    expect(approveCall).toContain('allowManualSourceTypes: true');
  });

  it('enriches the dev_autopilot.execution.bridged OASIS event payload with source_type', () => {
    const eventIdx = fn.indexOf("type: 'dev_autopilot.execution.bridged'");
    expect(eventIdx).toBeGreaterThan(-1);
    const eventBlock = fn.slice(eventIdx, fn.indexOf('});', eventIdx) + 3);
    expect(eventBlock).toContain('source_type: rec.source_type');
  });
});

describe('approveAutoExecute — the wider check is opt-in only (VTID-04108)', () => {
  const fn = extractFunctionBody(execSource, 'approveAutoExecute');

  it('branches on input.allowManualSourceTypes between the two predicates', () => {
    expect(fn).toMatch(/input\.allowManualSourceTypes/);
    expect(fn).toMatch(/isManuallyBridgeableSourceType\(rec\.source_type\)/);
    expect(fn).toMatch(/isExecutableSourceType\(rec\.source_type\)/);
  });
});

describe('autoApproveTick — never opts into the wider allowlist (the invariant this VTID exists to protect)', () => {
  const fn = extractFunctionBody(execSource, 'autoApproveTick');

  it('does not reference isManuallyBridgeableSourceType, MANUALLY_BRIDGEABLE_SOURCE_TYPES, or allowManualSourceTypes anywhere in its body', () => {
    expect(fn).not.toMatch(/isManuallyBridgeableSourceType/);
    expect(fn).not.toMatch(/MANUALLY_BRIDGEABLE_SOURCE_TYPES/);
    expect(fn).not.toMatch(/allowManualSourceTypes/);
  });

  it('its own approveAutoExecute call sites pass no allowManualSourceTypes flag', () => {
    const calls = fn.match(/await approveAutoExecute\(\{[^}]*\}\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toContain('allowManualSourceTypes');
    }
  });
});

describe('routes/autopilot-recommendations.ts — the /activate route bridge trigger matches what bridgeActivationToExecution itself accepts', () => {
  it('imports isManuallyBridgeableSourceType from the shared allowlist module', () => {
    expect(routeSource).toMatch(
      /import \{ isManuallyBridgeableSourceType \} from '\.\.\/services\/autopilot-executable-source-types'/,
    );
  });

  it('no longer hardcodes the old two-value dev_autopilot/dev_autopilot_impact check', () => {
    expect(routeSource).not.toContain(
      "srcType === 'dev_autopilot' || srcType === 'dev_autopilot_impact'",
    );
    expect(routeSource).toContain('isManuallyBridgeableSourceType(srcType)');
  });
});

/**
 * Extracts the body of a top-level function by name. Returns the substring
 * between the `function <name>` opener and the matching closing brace
 * at column 0. Good enough for lock-in assertions; not a real parser.
 */
function extractFunctionBody(src: string, name: string): string {
  // The lookahead requires the matched `{` to be immediately followed by
  // a newline — this VTID's target functions have an inline return-type
  // object literal (`Promise<{ ok: boolean; ... }>`) whose own `{` would
  // otherwise be matched first by a plain non-greedy `[\s\S]*?\{`, since
  // that brace is never itself followed by a newline (the object type is
  // written on one line, closing with `}>`).
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b[\\s\\S]*?\\{(?=\\s*\\n)`,
    'm',
  );
  const m = re.exec(src);
  if (!m) throw new Error(`could not locate function ${name} in source`);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}
