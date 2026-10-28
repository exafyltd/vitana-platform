/**
 * new-oasis-event-requires-union
 *
 * emitOasisEvent({ type: 'foo.bar' }) with a type string not in the
 * OasisEventType union in services/gateway/src/types/cicd.ts will be
 * rejected by TypeScript at build time IF caller types it explicitly,
 * but plenty of call sites pass anonymous objects that slip through.
 *
 * This rule extracts literal `type: 'x.y.z'` assignments from added
 * emitOasisEvent calls, then asserts the string appears somewhere in the
 * OasisEventType union on disk.
 *
 * Noise control:
 *   - Only triggers when the PR diff ADDS a new type literal.
 *   - Skips types containing template literal markers (`${...}`).
 *   - Skips tests (under /test/ or /__tests__/).
 */

import { extractAddedLines, readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'new-oasis-event-requires-union',
  category: 'companion',
  severity: 'blocker',
};

const EVENT_TYPE_RE = /emitOasisEvent\s*\(\s*\{[^}]*\btype\s*:\s*['"`]([a-z0-9_.-]+)['"`]/gi;
const CICD_TYPES_PATH = 'services/gateway/src/types/cicd.ts';

export async function check({ diff, repoRoot }) {
  const addedLines = extractAddedLines(diff, /\.(ts|tsx|mjs|js)$/);
  const newTypes = new Set();
  for (const l of addedLines) {
    if (/\/(test|tests|__tests__|__mocks__)\//.test(l.file)) continue;
    // The impact-rules files themselves document the patterns they match —
    // skip them so a rule that references `emitOasisEvent({ type: 'foo.bar' })`
    // as an example in a docstring doesn't trigger itself.
    if (/^scripts\/ci\/impact-rules\//.test(l.file)) continue;
    if (/^scripts\/ci\/scanners\//.test(l.file)) continue;
    // Also skip lines that are clearly inside comments.
    if (/^\s*(\*|\/\/|\*\/|\/\*)/.test(l.text)) continue;
    let m;
    EVENT_TYPE_RE.lastIndex = 0;
    while ((m = EVENT_TYPE_RE.exec(l.text)) !== null) {
      newTypes.add(m[1]);
    }
  }
  if (newTypes.size === 0) return [];

  const cicdSrc = readFileAtRepo(repoRoot, CICD_TYPES_PATH);
  if (!cicdSrc) {
    // Can't verify — emit a soft warning rather than a blocker.
    return [{
      rule: meta.rule,
      severity: 'warning',
      file_path: CICD_TYPES_PATH,
      line_number: null,
      message: `Could not read ${CICD_TYPES_PATH} to verify event-type union. Verify manually that [${[...newTypes].join(', ')}] are listed.`,
      suggested_action: `Ensure each new event-type string literal appears in the OasisEventType union in ${CICD_TYPES_PATH}.`,
      raw: { new_event_types: [...newTypes] },
    }];
  }

  const missing = [...newTypes].filter(t => !cicdSrc.includes(`'${t}'`) && !cicdSrc.includes(`"${t}"`));
  if (missing.length === 0) return [];

  return missing.map(t => ({
    rule: meta.rule,
    severity: meta.severity,
    file_path: CICD_TYPES_PATH,
    line_number: null,
    message: `emitOasisEvent uses type '${t}' but '${t}' is not declared in the OasisEventType union at ${CICD_TYPES_PATH}.`,
    suggested_action: `Add \`| '${t}'\` to the OasisEventType union in ${CICD_TYPES_PATH}. Runtime handlers that filter on this type will otherwise silently drop the event.`,
    raw: { event_type: t },
  }));
}
