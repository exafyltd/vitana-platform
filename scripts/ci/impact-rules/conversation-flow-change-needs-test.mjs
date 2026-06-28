/**
 * conversation-flow-change-needs-test
 *
 * THE RULE (operator request, 2026-06-28): the conversation flow is the product.
 * Every change to how Vitana decides what to say / which session to surface /
 * what context she carries MUST ship with a test in the SAME PR — so flow
 * behaviour can never silently regress again (e.g. "offer session 1 while the
 * user is on session 10", "I cannot execute").
 *
 * Heuristic: if this PR adds/modifies any CONVERSATION-FLOW source file, it must
 * also add/modify at least one conversation-flow TEST file. If it doesn't, the
 * check fails (blocker) — mirroring `new-route-needs-test`, but for the flow
 * surface, and as a hard gate rather than a warning.
 *
 * Escape hatch (rare — genuinely behaviour-free edits: a comment, a log line, a
 * rename): put `flow-test-exempt: <reason>` in a changed flow file (a code
 * comment is fine). A flow file carrying that marker is excluded from the gate.
 *
 * The flow surface and the flow-test set are kept deliberately broad so new flow
 * modules are covered by default; extend the regexes when a new flow area lands.
 */

import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'conversation-flow-change-needs-test',
  category: 'companion',
  severity: 'blocker',
};

// Source files that define conversation-flow BEHAVIOUR (what Vitana says / picks
// / remembers). Test + .d.ts files are excluded below.
const FLOW_SOURCE_RE = [
  /^services\/gateway\/src\/services\/conversation\/.+\.(ts|tsx)$/,        // next-best-action, decide-opening, screen-surface
  /^services\/gateway\/src\/services\/assistant-continuation\/.+\.(ts|tsx)$/, // briefing / continuation providers
  /^services\/gateway\/src\/services\/guide\/.+\.(ts|tsx)$/,               // temporal bucket / recency
  /^services\/gateway\/src\/services\/guided-journey\/.+\.(ts|tsx)$/,      // journey state
  /^services\/gateway\/src\/orb\/live\/instruction\/.+\.(ts|tsx)$/,        // system-instruction builder
  /^services\/gateway\/src\/orb\/live\/session\/live-session-controller\.ts$/, // bootstrap-context assembly
  /^services\/gateway\/src\/services\/orb-tools-shared\.ts$/,              // the ORB action/flow tools (narrate, NBA, …)
];

// A changed test file that counts as covering the flow change. Broad on purpose:
// the flow suites live under many names (conversation-flow, narrate-guided-session,
// guided-journey-*, journey-*, greeting-*, wake-*, continuity-*, system-instruction…).
const FLOW_TEST_RE =
  /^services\/gateway\/test\/.*(conversation|narrate|guided|journey|greeting|wake|continuity|screen|opening|next-best|decide|instruction|session|nba|recency|temporal).*\.(test|spec)\.(ts|tsx)$/i;

const TEST_OR_DTS_RE = /\.(test|spec)\.(ts|tsx)$|\.d\.ts$/;
const EXEMPT_RE = /flow-test-exempt/;

export async function check({ changedFiles, repoRoot }) {
  const flowSource = changedFiles.filter(
    (f) =>
      (f.status === 'A' || f.status === 'M') &&
      !TEST_OR_DTS_RE.test(f.path) &&
      FLOW_SOURCE_RE.some((re) => re.test(f.path)),
  );
  if (flowSource.length === 0) return [];

  // Escape hatch: drop flow files that carry the `flow-test-exempt` marker.
  const gated = flowSource.filter((f) => {
    const src = readFileAtRepo(repoRoot, f.path);
    return !(src && EXEMPT_RE.test(src));
  });
  if (gated.length === 0) return [];

  // Did the PR touch a conversation-flow test?
  const hasFlowTest = changedFiles.some(
    (f) => (f.status === 'A' || f.status === 'M') && FLOW_TEST_RE.test(f.path),
  );
  if (hasFlowTest) return [];

  return [
    {
      rule: meta.rule,
      severity: meta.severity,
      file_path: gated[0].path,
      line_number: null,
      message:
        `This PR changes conversation-flow code (${gated.length} file(s), e.g. ${gated[0].path}) ` +
        `but adds/updates no conversation-flow test. Flow behaviour must ship with a test in the same PR.`,
      suggested_action:
        `Add or extend a test under services/gateway/test/ that pins the new flow behaviour ` +
        `(e.g. narrate-guided-session-shared.test.ts, conversation-flow.test.ts, ` +
        `guided-journey-standing-instruction.test.ts). For a genuinely behaviour-free edit ` +
        `(comment / log / rename), add \`flow-test-exempt: <reason>\` in a changed flow file.`,
      raw: { flow_files: gated.map((f) => f.path) },
    },
  ];
}
