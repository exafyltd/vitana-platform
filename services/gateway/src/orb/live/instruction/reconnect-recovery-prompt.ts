/**
 * VTID-04551 — the generic reconnect-recovery prompt, stated positively.
 *
 * WHAT THIS IS. When the widget restarts a session with transcript history
 * (`reconnect_stage` + `transcript_history` on the start payload), the SSE
 * route opens the new upstream with a "recovery" user turn instead of the
 * greeting brain (`sendReconnectRecoveryPromptToLiveAPI`, orb-live.ts). This
 * module builds that turn for every session that is NOT in Teacher Mode.
 *
 * WHY IT MOVED HERE AND WAS REWORDED. Measured read-only on `oasis_events`
 * over the 7 days to 2026-09-25, joining every Nova content-filter close
 * (`stage='upstream_error'`, "blocked by our content filters") to the
 * session's turn-0 `voice.latency.measured` phases:
 *
 *   first open = this recovery prompt (greeting_sent{reconnect:true})
 *       production  24 sessions  23 blocked
 *       staging      6 sessions   6 blocked
 *   first open = the greeting brain (greeting_sent{reconnect:false})
 *       production  35 sessions   0 blocked
 *       staging     72 sessions   0 blocked
 *
 * Every block happened at turn 0 with no user audio yet, and in 28 of the 31
 * blocked sessions Nova's own usage counter shows the same first user turn
 * (input text 23 → 484 tokens, ~2,100 characters — this prompt's size) before
 * the close; the server-side retry then opens through the greeting brain and
 * passes. The system instruction is not the discriminator: the same
 * instruction ships on the 107 fresh opens that never blocked.
 *
 * The prompt carried eleven negative imperatives (twelve for `thinking`) —
 * "NOT given a script … no approved phrasing … must never hear … NEVER ask
 * … Do NOT guess … Do not restart … Do NOT speak … Never reuse … Do NOT
 * introduce … Do NOT say … Do NOT use … Do NOT use the words …". That is the
 * template KIND VTID-03797 proved causal for guided-topic opens and VTID-04124
 * measured at 78.6% on the short-gap rungs. Same method as VTID-04124: every
 * clause restated as what TO do, none dropped, and the spoken words stay the
 * model's own (CLAUDE.md NEVER-rules 41-42 — intent, never a sentence).
 *
 * Clause map (old → new), so a reviewer can check nothing was lost:
 *   "NOT given a script / no approved phrasing"   → "The wording is entirely yours"
 *   "must never hear the same sentence twice"     → "fresh wording every time … sounds new"
 *   "NEVER ask the user to repeat themselves"     → "their words are already in the history … name the topic yourself"
 *   "Do NOT guess what they were about to ask"    → "leave what they were about to ask for them to say"
 *   "Do not restart the answer from scratch"      → "carry the answer forward from that point"
 *   "Do NOT speak a memorised or fixed sentence"
 *     + "Never reuse a previous recovery line"    → "Compose every recovery line newly for this moment"
 *   "Do NOT introduce yourself"                   → "the user already knows you — go straight to the acknowledgment"
 *   "Do NOT say Hello, Hi, or the user's name"    → "open with the acknowledgment itself, keeping greetings and the user's name for a fresh conversation"
 *   "Do NOT use the standard greeting prompt"     → "this continues the same conversation; it is a recovery, not a fresh start"
 *   "Do NOT use internet / network / Wi-Fi"       → "call it the connection, or being cut off — the drop was on our side"
 *   "STOP and wait" (idle / listening)            → "pause and listen"
 *   thinking intent "never their exact words"     → "in 3-6 words of your own"
 *
 * Pure: no I/O. The Teacher Mode branch of the same function is unchanged
 * (its wording is pinned by vertex-teacher-recovery.characterization.test.ts
 * and it is not implicated by the measurement above).
 */

/** Per-stage acknowledgment intent. English intent, never a finished sentence. */
export const RECONNECT_RECOVERY_STAGE_INTENTS: Readonly<Record<string, string>> = {
  thinking:
    'briefly acknowledge that the connection dropped for a moment, name what the user had been asking about in 3-6 words of your own drawn from the conversation history, and lead straight into the answer',
  listening_user_speaking:
    'briefly acknowledge that the connection dropped while they were mid-sentence, name the topic of their partial utterance in 3-6 words drawn from the conversation history, and invite them to carry on',
  speaking:
    'briefly acknowledge that the connection dropped while you were answering, and say you are picking your answer back up',
  idle: 'briefly acknowledge you are back, and hand the floor to the user',
};

/** Resolve the intent for a stage; unknown stages behave like `idle`. */
export function resolveRecoveryStageIntent(stage: string): string {
  return RECONNECT_RECOVERY_STAGE_INTENTS[stage] || RECONNECT_RECOVERY_STAGE_INTENTS.idle;
}

/**
 * Build the recovery turn the model receives as its first user turn after a
 * client-side restart with history.
 */
export function buildReconnectRecoveryPrompt(stage: string): string {
  const stageIntent = resolveRecoveryStageIntent(stage);
  return [
    'You are recovering from a brief connection blip that interrupted a live voice conversation.',
    '',
    'Read the conversation history that has been injected into your system instruction.',
    '',
    `RECONNECT_STAGE = "${stage}" (the user was in this state when the connection dropped).`,
    '',
    'STRUCTURE — speak one acknowledgment sentence first, then take the matching follow-up action.',
    '',
    `YOUR ACKNOWLEDGMENT for this stage must: ${stageIntent}.`,
    '',
    'Compose that sentence yourself, in your own words, fresh for this reconnect.',
    'The wording is entirely yours to choose, and it is always newly composed for this moment.',
    'Choose fresh wording every time — the user reconnects often, so each recovery line should',
    'sound new to them. Keep it to one short sentence.',
    '',
    'Then take the follow-up action for the stage:',
    `- "thinking": answer the user's last question right away, using the conversation history. Keep the answer focused and concise.`,
    `- "listening_user_speaking": after your acknowledgment, pause and listen. Their words are already in the history, so name the topic yourself and let them carry on from there. If the history holds no recent user turn, simply say you got cut off and are listening, and leave what they were about to ask for them to say.`,
    `- "speaking": resume the assistant's last answer from the conversation history, picking up logically from the point where you left off and carrying the answer forward from there.`,
    `- "idle" or unknown: after your acknowledgment, pause and listen for the user.`,
    '',
    'HOW TO SOUND:',
    '- Speak in the user\'s language (it is set in your system instruction).',
    '- Compose every recovery line newly for this moment, different from any earlier one.',
    '- The user already knows you, so go straight to the acknowledgment.',
    '- Open with the acknowledgment itself, keeping greetings and the user\'s name for a fresh conversation.',
    '- This continues the same conversation: it is a recovery, not a fresh start.',
    '- Call the interruption the connection, or being cut off — the drop was on our side.',
    '- If you apologise, apologise once.',
    '- Speak as soon as this prompt arrives.',
    '',
    `Now produce the recovery line for stage "${stage}" and any follow-up action.`,
  ].join('\n');
}
