/**
 * VTID-04553 — acknowledge before a slow tool, behind a flag.
 *
 * WHY. Measured on voice sessions: a turn that needs a tool spends p50 2.2 s
 * between the user's final transcript and the tool dispatch, and chained
 * tools leave 3-17 s of silence before the first spoken word. The member
 * hears nothing and cannot tell a lookup from a dropped connection. The
 * cheapest fix is behavioural: let the model say a short "checking" line of
 * its own before it calls a tool that may take a moment.
 *
 * WHAT. One English INTENT paragraph added to the TOOLS section of the live
 * system instruction (`buildLiveSystemInstruction`, the single builder both
 * the Nova Sonic and the Vertex setup envelopes use). It describes the
 * behaviour, never the words (CLAUDE.md NEVER-rules 41-42), and is phrased
 * positively throughout — Nova's content filter scores stacks of negative
 * imperatives as injection-like (VTID-03797, VTID-04124, VTID-04551), so this
 * paragraph carries none.
 *
 * FLAG. `ORB_TOOL_ACK_INTENT_ENABLED` — exact string `'true'` enables, like
 * every other activation gate in this service; anything else (unset, a typo)
 * leaves the instruction byte-identical to the pre-VTID-04553 text. Read at
 * call time, so a task-definition change needs no code change.
 *
 * BUDGET. The paragraph sits in the static scaffold, which
 * `enforceInstructionBudget` never trims. Measured on the `instruction_budget`
 * diag (VTID-04525): the authenticated scaffold is already 31.8-32.9 KB,
 * above the 30,720-byte budget on its own, so every trimmable section
 * (bootstrap, history, specialist) is already dropped on those sessions and
 * the guard reports `still_over_budget`. Adding this paragraph therefore
 * pushes no further content out; it grows the (already over-budget) total by
 * its own size. Placing it in a trimmable section instead would mean it is
 * always dropped.
 *
 * NOT ADDED: an intent that independent lookups may be requested together.
 * The Nova output normalizer (`NovaOutputNormalizer`, nova-sonic-protocol.ts)
 * holds exactly one pending `toolUse` and emits it when its TOOL `contentEnd`
 * arrives; a second `toolUse` opened before the first closes would overwrite
 * it. Sequential tool blocks work, but nothing in this code base establishes
 * that Nova emits several tool uses in one turn, so the instruction does not
 * ask for it.
 */

/** The exact paragraph appended when the flag is on. English intent only. */
export const TOOL_ACK_INTENT_PARAGRAPH =
  "- ACKNOWLEDGE BEFORE SLOW LOOKUPS: when answering needs a tool that can take a moment (searching, looking something up, several steps), first say one very brief, natural acknowledgement in the user's language that you are checking — in your own words, different each time — then call the tool right away. Instant actions such as opening a screen go straight to the tool. Describe what you are doing in everyday words and keep tool names to yourself.";

/** `ORB_TOOL_ACK_INTENT_ENABLED === 'true'` — default OFF. */
export function isToolAckIntentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORB_TOOL_ACK_INTENT_ENABLED === 'true';
}

/**
 * The text to splice into the TOOLS section: the paragraph plus its line
 * break when enabled, the empty string otherwise (so flag-off output is
 * byte-identical to the instruction before this VTID).
 */
export function buildToolAckIntentLine(env: NodeJS.ProcessEnv = process.env): string {
  return isToolAckIntentEnabled(env) ? `${TOOL_ACK_INTENT_PARAGRAPH}\n` : '';
}
