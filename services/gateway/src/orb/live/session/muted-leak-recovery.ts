/**
 * VTID-04714: answer the member after a reply was muted for leaked internals.
 *
 * Live B-CONF-05 (staging 7045c16, pass 7): the member said "Nein, eigentlich
 * hat Paul am siebten Mai Geburtstag." Nova spoke its own reasoning — "Der
 * Benutzer hat gesagt … In den strukturierten Fakten steht paul_birthday …
 * Dafür gibt es die Funktion remember_fact …". The VTID-04480 guard muted the
 * turn at the snake_case key, and the member heard the start of the reasoning
 * and then nothing: no tool call, no answer.
 *
 * The guard now also mutes on the reasoning itself (opening-turn-guard.ts),
 * and this module asks for the answer the member should have heard — unless
 * a memory backstop already told Nova the real outcome for this turn, which
 * would make a second prompt produce two replies. The note states the intent
 * only; Nova composes the reply (spoken wording is never hardcoded).
 */

import { REMEMBER_BACKSTOP_MARKER } from '../../../services/memory/remember-backstop';

type EmitDiag = (session: any, stage: string, payload?: Record<string, unknown>) => void;

/** How long to wait for the memory backstops before deciding. */
export const LEAK_RECOVERY_WAIT_MS = 6_000;

export function buildMutedLeakNote(): string {
  return [
    `${REMEMBER_BACKSTOP_MARKER} System note, not said by the member: the member did not hear your previous reply — it was muted because it read internal data or your own reasoning aloud.`,
    "Answer the member's last message now, speaking only to them, briefly and in their language.",
    'Never mention the user in the third person, functions, tools, keys or stored-fact names.',
    'If they are correcting something you have stored, name what is stored and ask which one is right before changing anything.',
  ].join('\n');
}

export async function maybeRecoverFromMutedLeak(
  ctx: { deps: { emitDiag: EmitDiag } },
  session: any,
  kind: string,
  since: number,
  backstops: Array<unknown>,
  waitMs = LEAK_RECOVERY_WAIT_MS,
): Promise<'sent' | 'backstop_answered' | 'inactive'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  await Promise.race([
    Promise.all(backstops.map((b) => Promise.resolve(b).catch(() => undefined))),
    timeout,
  ]);
  if (timer) clearTimeout(timer);

  if (!session?.active || !session.upstreamClient) return 'inactive';
  if (Number(session.backstopNoteSentAt || 0) >= since) {
    ctx.deps.emitDiag(session, 'muted_leak_recovery', { kind, outcome: 'backstop_answered' });
    return 'backstop_answered';
  }
  session.upstreamClient.sendTextTurn(buildMutedLeakNote(), true);
  session.backstopNoteSentAt = Date.now();
  ctx.deps.emitDiag(session, 'muted_leak_recovery', { kind, outcome: 'sent' });
  return 'sent';
}
