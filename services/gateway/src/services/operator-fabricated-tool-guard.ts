/**
 * VTID-04582: flag an Operator Console reply that presents a tool call which
 * did not happen in this turn.
 *
 * Observed 2026-09-25 19:17 UTC on staging: the turn called only
 * autopilot_review_execution, but the reply read
 *   "Tool: autopilot_approve_execution
 *    Result: {"ok":true, ... "pr_number":3709, "github_auth":"app_token_vitana/github/pat"}
 *    ✅ Done — the 401 is gone and the PR is open."
 * No approval ran, no PR was opened, and PR #3709 did not exist yet. The text
 * was taken as proof by the reader. A prompt rule asks the model not to do
 * this; this check makes a fabrication visible whatever the model does.
 *
 * Only the two shapes that PRESENT a call as done are matched — a line opening
 * with "Tool:" / "Tool call:" and "Ran <tool>" (the Command Hub's own activity
 * wording). Prose such as "I can call autopilot_approve_execution" is not.
 * A name counts only if it is a declared tool, so ordinary words never match.
 */

const CLAIM_PATTERNS: RegExp[] = [
  /(?:^|\n)[ \t>*_-]*Tool(?:\s+call)?[*_]*\s*:[\s`*_]*([a-z][a-z0-9_]+)/gi,
  /(?:^|\n|[.!?]\s)[ \t>*_-]*Ran[\s`*_]+([a-z][a-z0-9_]+)/gi,
];

export function findFabricatedToolClaims(
  reply: string,
  calledTools: Iterable<string>,
  declaredTools: Iterable<string>,
): string[] {
  if (!reply) return [];
  const called = new Set(calledTools);
  const declared = new Set(declaredTools);
  const found = new Set<string>();
  for (const re of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(reply)) !== null) {
      const name = m[1];
      if (declared.has(name) && !called.has(name)) found.add(name);
    }
  }
  return [...found];
}

export function fabricatedToolNotice(names: string[]): string {
  const list = names.map((n) => `\`${n}\``).join(', ');
  return `\n\n---\n⚠️ Not verified: this reply presents ${names.length === 1 ? 'a call' : 'calls'} to ${list}, but no such call ran in this turn. Nothing it describes as done by ${names.length === 1 ? 'that tool' : 'those tools'} has happened. Ask again to run it for real.`;
}
