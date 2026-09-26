/**
 * VTID-04644 — open the screen when the member plainly asked and the model did not.
 *
 * Measured on production (VTID-04629): "show me where I can make a post" was
 * answered with words ("it's in the news feed … I can't take you there") and
 * no navigation. The registry knows the screen; the model just did not open
 * it. This runs at turn_complete, after the model's reply:
 *
 *   - the member's words are an explicit open request ("open …", "show me …",
 *     "take me to …", "öffne …", "zeig mir …", "bring mich …", and the same
 *     in the other shipped languages), not negated;
 *   - nothing was navigated during the turn and nothing is pending;
 *   - the registry resolver gives ONE clear match for the member's words
 *     (an ambiguous or empty result does nothing — the model's question or
 *     answer stands);
 *
 * then the screen opens through openScreen(), with every gate (access,
 * viewport, already there) exactly as when the model calls the tool.
 *
 * Registry dispatcher only (NAV_V2_ENABLED), never on role surfaces the
 * registry does not cover. `ORB_NAV_OPEN_BACKSTOP_ENABLED=false` turns it off.
 */
import WebSocket from 'ws';
import { isLegacySurface, isNavV2Enabled, openScreen, type NavCallContext } from '../../../navigation/nav-dispatch';
import { recordPendingNavAck, type NavAckSession } from '../../../navigation/nav-ack';
import { resolveScreenRequest } from '../../../navigation/nav-service';
import { markNavigationDispatchedThisTurn } from './navigation-turn-scope';

export function isExplicitOpenBackstopEnabled(): boolean {
  return (process.env.ORB_NAV_OPEN_BACKSTOP_ENABLED ?? 'true') !== 'false';
}

// JS \b only knows ASCII letters, so "Öffne" or "aç" would never match it.
// B = a boundary that treats every Unicode letter as part of a word.
const B_START = '(?<![\\p{L}\\p{N}])';
const B_END = '(?![\\p{L}\\p{N}])';
const words = (alts: string[]) => `${B_START}(?:${alts.join('|')})${B_END}`;

/** Verbs that ask for a screen to be opened, per shipped language. */
const OPEN_REQUEST = new RegExp(
  [
    // en
    words(['open', 'pull up', 'bring up', 'show me', 'take me', 'bring me', 'navigate to', 'go to']),
    // de
    words(['öffne', 'öffnen', 'oeffne', 'zeig mir', 'zeige mir', 'zeig mal', 'bring mich', 'führ mich', 'fuehr mich', 'geh zu', 'gehe zu', 'navigiere']),
    `${B_START}mach${B_END}[^.?!]{0,40}${B_START}auf${B_END}`,
    // es / pt / it / fr
    words(['abre', 'ábreme', 'abreme', 'muéstrame', 'muestrame', 'enséñame', 'llévame', 'llevame', 'abra', 'mostre-me', 'me mostra', 'me mostre', 'me leva', 'leva-me', 'apri', 'mostrami', 'portami', 'ouvre', 'montre-moi', 'emmène-moi', 'emmene-moi', 'amène-moi']),
    // sr / pl
    words(['otvori', 'pokaži mi', 'pokazi mi', 'odvedi me', 'vodi me', 'otwórz', 'otworz', 'pokaż mi', 'pokaz mi', 'zabierz mnie']),
    // ru / tr
    words(['открой', 'покажи', 'перейди', 'отведи меня', 'aç', 'göster', 'götür']),
    // ar / zh (no word spacing to lean on)
    'افتح|أرني|اعرض لي|خذني|打开|打開|带我去|帶我去|给我看|給我看',
  ].join('|'),
  'iu',
);

/** The member said not to, or is talking about something being open. */
const NOT_A_REQUEST = new RegExp(
  [
    `${words(["don't", 'dont', 'do not', 'never', 'no need to', 'not now', 'stop'])}[^.?!]{0,30}${words(['open', 'show', 'take', 'bring', 'go'])}`,
    `${words(["i'm", 'im', 'i am', 'is', 'are', 'was', 'were', 'be', "it's", 'stay', 'stays'])}\\s+open${B_END}`,
    `${words(['nicht', 'kein', 'nie'])}[^.?!]{0,30}${B_START}(?:öffne|öffnen|zeig|bring)`,
    `${B_START}(?:öffne|öffnen|zeig\\p{L}*|bring)${B_END}[^.?!]{0,30}${B_START}nicht${B_END}`,
    `${B_START}no\\s+(?:abras|me muestres|me lleves|abra)${B_END}`,
    `${B_START}(?:ne|n['’])[^.?!]{0,20}${B_START}pas${B_END}`,
    words(['nemoj', 'не', 'açma']),
  ].join('|'),
  'iu',
);

export function detectExplicitOpenRequest(text: string): boolean {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 4) return false;
  return OPEN_REQUEST.test(t) && !NOT_A_REQUEST.test(t);
}

export interface ExplicitOpenSession extends NavAckSession {
  active?: boolean;
  lang?: string;
  isAnonymous?: boolean;
  is_mobile?: boolean;
  clientContext?: { isMobile?: boolean } | null;
  navigationDispatched?: boolean;
  navigationDispatchedTurn?: number;
  turn_count?: number;
  pendingNavigation?: unknown;
  sseResponse?: { write(chunk: string): unknown } | null;
  clientWs?: { readyState: number } | null;
}

type EmitDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

export interface ExplicitOpenDeps {
  emitDiag: EmitDiag;
  sendWsMessage: (ws: any, msg: Record<string, unknown>) => void;
}

/**
 * Decide and run. `navigatedDuringTurn` is read by the caller BEFORE it
 * advances turn_count. Returns the promise so tests can await it; the
 * handler never does.
 */
export function maybeRunExplicitOpenBackstop(
  deps: ExplicitOpenDeps,
  sessionIn: unknown,
  userText: string,
  navigatedDuringTurn: boolean,
): Promise<string | null> | null {
  const session = sessionIn as ExplicitOpenSession;
  if (!isExplicitOpenBackstopEnabled() || !isNavV2Enabled()) return null;
  if (!session.active || navigatedDuringTurn || session.navigationDispatched || session.pendingNavigation) return null;
  const currentRoute = session.current_route || null;
  if (isLegacySurface(currentRoute)) return null;
  if (!detectExplicitOpenRequest(userText)) return null;

  const words = userText.replace(/\s+/g, ' ').trim().slice(-300);
  const markBefore = session.navigationDispatchedTurn;
  const ackBefore = session.pendingNavAck?.sent_at;
  const navCtx: NavCallContext = {
    lang: session.lang || 'en',
    isAnonymous: !!session.isAnonymous,
    isMobile: session.is_mobile === true || session.clientContext?.isMobile === true,
    currentRoute,
    sessionId: session.sessionId || null,
  };

  return (async () => {
    const r = await resolveScreenRequest(words, {
      lang: navCtx.lang,
      authenticated: !navCtx.isAnonymous,
      viewport: navCtx.isMobile ? 'mobile' : undefined,
    });
    if (r.kind !== 'match') {
      deps.emitDiag(session, 'nav_open_backstop', { outcome: r.kind, candidates: 'candidates' in r ? r.candidates.slice(0, 3).map((c) => c.screen_id) : [] });
      return null;
    }
    // The model navigated while the resolver ran: defer to it.
    if (
      !session.active || session.navigationDispatched || session.pendingNavigation ||
      session.navigationDispatchedTurn !== markBefore || session.pendingNavAck?.sent_at !== ackBefore
    ) {
      return null;
    }
    const opened = await openScreen(r.screen.screen_id, 'explicit_open_backstop', navCtx);
    const directive = opened.ok ? (opened.result as { directive?: Record<string, unknown> } | undefined)?.directive : undefined;
    if (!directive) {
      deps.emitDiag(session, 'nav_open_backstop', { outcome: 'not_opened', screen_id: r.screen.screen_id });
      return null;
    }
    // The model's reply has already played: run as soon as audio drains
    // instead of waiting for a turn_complete that has already gone by.
    const payload: Record<string, unknown> = { ...directive, after_turn: true };
    if (session.sseResponse) {
      try { session.sseResponse.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* SSE closed */ }
    }
    if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
      try { deps.sendWsMessage(session.clientWs, payload); } catch { /* WS closed */ }
    }
    recordPendingNavAck(session, payload);
    markNavigationDispatchedThisTurn(session);
    deps.emitDiag(session, 'nav_open_backstop', { outcome: 'opened', screen_id: r.screen.screen_id, route: payload.route, top_score: r.top_score });
    console.log(`[VTID-04644] explicit open backstop ${session.sessionId}: opened ${r.screen.screen_id} (${String(payload.route)})`);
    return r.screen.screen_id;
  })().catch((err: any) => {
    console.warn(`[VTID-04644] explicit open backstop failed (non-blocking): ${err?.message ?? err}`);
    return null;
  });
}
