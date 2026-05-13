/**
 * A8.3a.2 (orb-live-refactor / VTID-02968): upstream Live message handler.
 *
 * Lifted verbatim (body) from `routes/orb-live.ts:~5772` (the named
 * `handleUpstreamLiveMessage` function created in A8.3a.1). The 961-line
 * body now lives here, with module-level orb-live.ts helpers parameterized
 * through `UpstreamMessageHandlerDeps`. The connectToLiveAPI Promise
 * closure variables (`setupComplete`, `connectionTimeout`, `resolve`) flow
 * through `ctx.onSetupComplete()` + `ctx.isSetupComplete()`.
 *
 * A8.3 sub-split sequence:
 *   A8.3a.1 (shipped) — name the inline closure + migrate SSE writes to
 *                       writeSseEvent (A9.2).
 *   A8.3a.2 (this)    — move the named function to this file with the
 *                       deps-bag + context-bag pattern.
 *   A8.3b (next)      — replace `connectToLiveAPI(session, audioCb, ...)`
 *                       with `new VertexLiveClient()` (A7) + typed event
 *                       handlers that call into this same body.
 *   L1 (after)        — provider-selection wiring (Vertex default,
 *                       LiveKit selectable).
 *
 * Hard rules:
 *   1. Zero behavior change. Body lifted verbatim except for ~27 mechanical
 *      dep substitutions (`name(` → `ctx.deps.name(`) and the 3-line setup-
 *      complete handshake collapsed into `ctx.onSetupComplete()`.
 *   2. Wire format byte-for-byte identical (writeSseEvent envelope unchanged
 *      from A8.3a.1).
 *   3. No imports from `routes/orb-live.ts` other than the typed
 *      `GeminiLiveSession` interface — orb-live.ts continues to depend on
 *      this module via the factory, never the reverse.
 *   4. No LiveKit, no provider selection, no contextual-intelligence
 *      changes.
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { GeminiLiveSession } from '../../../routes/orb-live';
import type { MemoryIdentity } from '../../../services/orb-memory-bridge';
import { writeSseEvent } from '../transport/sse-handler';
import {
  POST_TURN_COOLDOWN_MS,
  MAX_CONSECUTIVE_MODEL_TURNS,
  MAX_CONSECUTIVE_TOOL_CALLS,
  TURN_RESPONSE_TIMEOUT_MS,
  SILENCE_AUDIO_B64,
  SILENCE_IDLE_THRESHOLD_MS,
  SILENCE_KEEPALIVE_INTERVAL_MS,
} from '../../upstream/constants';
import { emitOasisEvent } from '../../../services/oasis-event-service';
import { handleIdentityIntent } from '../../../services/identity-intent-handler';
import { deduplicatedExtract } from '../../../services/extraction-dedup-manager';
import {
  writeMemoryItemWithIdentity,
  DEV_IDENTITY,
} from '../../../services/orb-memory-bridge';
import { addTurn as addSessionTurn } from '../../../services/session-memory-buffer';
import { addTurnRedis } from '../../../services/redis-turn-buffer';
import { getSupabase } from '../../../lib/supabase';
import { VITANA_BOT_USER_ID } from '../../../lib/vitana-bot';

/**
 * orb-live.ts-local helpers the handler body invokes. Future slices may
 * lift these out individually; until then, the deps-bag is the seam.
 */
export interface UpstreamMessageHandlerDeps {
  clearResponseWatchdog: (session: GeminiLiveSession) => void;
  detectAuthIntent: (text: string) => any;
  emitDiag: (
    session: GeminiLiveSession,
    stage: string,
    extra?: Record<string, unknown>,
  ) => void;
  emitLiveSessionEvent: (
    eventType: any,
    payload: Record<string, unknown>,
    status?: 'info' | 'warning' | 'error',
  ) => Promise<void>;
  executeLiveApiTool: (...args: any[]) => Promise<any>;
  isDevSandbox: () => boolean;
  sendAudioToLiveAPI: (
    ws: WebSocket,
    audioB64: string,
    mimeType?: string,
  ) => boolean;
  sendFunctionResponseToLiveAPI: (...args: any[]) => boolean;
  sendWsMessage: (ws: WebSocket, message: Record<string, unknown>) => void;
  startResponseWatchdog: (
    session: GeminiLiveSession,
    timeoutMs: number,
    reason: string,
  ) => void;
}

/**
 * Per-call context — captures the connectToLiveAPI Promise closure state +
 * user callbacks the handler body depends on. The factory returns a
 * handler bound to this context.
 */
export interface UpstreamMessageHandlerContext {
  session: GeminiLiveSession;
  ws: WebSocket;
  callbacks: {
    onAudioResponse: (audioB64: string) => void;
    onTextResponse: (text: string) => void;
    onError: (error: Error) => void;
    onTurnComplete?: () => void;
    onInterrupted?: () => void;
  };
  /**
   * Mutates the outer `setupComplete` let, clears `connectionTimeout`,
   * and resolves the connect Promise. Called once per session when the
   * upstream sends `setup_complete`.
   */
  onSetupComplete: () => void;
  /** Read-only view of the outer `setupComplete` boolean. */
  isSetupComplete: () => boolean;
  deps: UpstreamMessageHandlerDeps;
}

/**
 * Factory: builds a `(data: WebSocket.Data) => void` handler bound to a
 * specific session + connectToLiveAPI Promise context.
 *
 * Use:
 *   const handler = createUpstreamLiveMessageHandler({...});
 *   ws.on('message', handler);
 */
export function createUpstreamLiveMessageHandler(
  ctx: UpstreamMessageHandlerContext,
): (data: WebSocket.Data) => void {
  const { session, ws } = ctx;

    function handleUpstreamLiveMessage(data: WebSocket.Data): void {
      try {
        const rawData = data.toString();
        const message = JSON.parse(rawData);
        const messageKeys = Object.keys(message);

        // VTID-STREAM-KEEPALIVE: Reduce logging volume — skip verbose logs for audio-heavy
        // server_content messages. Previously every audio chunk (dozens per second) was logged
        // with 300 chars of raw base64, causing CPU pressure and event loop delays.
        const isServerContent = !!(message.server_content || message.serverContent);
        if (!isServerContent) {
          // Non-audio messages (setup_complete, tool_call, etc.) — log fully
          console.log(`[VTID-01219] Received from Gemini: keys=${messageKeys.join(',')}, len=${rawData.length}`);
        }

        // Check for setup completion (handle both snake_case and camelCase)
        if (message.setup_complete || message.setupComplete) {
          console.log(`[VTID-01219] Live API setup complete for session ${session.sessionId}`);
          ctx.onSetupComplete();

          // VTID-STREAM-KEEPALIVE: Start ping interval to prevent idle timeout.
          // Without this, Cloud Run ALB or Vertex AI can terminate idle connections.
          // Ping every 25s keeps the connection alive during natural pauses in conversation.
          session.upstreamPingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.ping();
              } catch (e) {
                // ping can throw if socket is closing — ignore
              }
            }
          }, 25_000);

          // VTID-STREAM-SILENCE: Start silence keepalive to prevent Vertex idle timeout.
          // Vertex closes the audio stream with code 1000 after ~25-30s of no audio input.
          // This sends silent PCM frames when no client audio has been forwarded recently.
          session.lastAudioForwardedTime = Date.now();
          session.silenceKeepaliveInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || !session.active) return;
            // Skip silence keepalive while model is speaking — Vertex won't idle-timeout
            // during active generation, and sending audio input during output causes
            // Vertex VAD to briefly process the input, creating audible glitches.
            if (session.isModelSpeaking) return;
            const idleMs = Date.now() - session.lastAudioForwardedTime;
            if (idleMs >= SILENCE_IDLE_THRESHOLD_MS) {
              try {
                ctx.deps.sendAudioToLiveAPI(ws, SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
                // Don't update lastAudioForwardedTime — silence doesn't count as real audio
              } catch (e) {
                // WS may be closing — ignore
              }
            }
          }, SILENCE_KEEPALIVE_INTERVAL_MS);

          // setup-complete handshake completed via ctx.onSetupComplete() above
          return;
        }

        // Handle server content (audio/text responses) - handle both formats
        const serverContent = message.server_content || message.serverContent;
        if (serverContent) {
          const content = serverContent;

          // VTID-STREAM-KEEPALIVE: Only log server_content keys for non-audio events
          // (turn_complete, interrupted, transcription). Audio chunks are too frequent to log.
          const contentKeys = Object.keys(content);
          const hasModelTurn = !!(content.model_turn || content.modelTurn);
          if (!hasModelTurn) {
            console.log(`[VTID-01225] server_content keys: ${contentKeys.join(', ')}`);
          }

          // Handle interruption (handle both formats)
          const interrupted = content.interrupted || content.grounding_metadata?.interrupted;
          if (interrupted) {
            console.log(`[VTID-VOICE-INIT] Interrupted for session ${session.sessionId}`);
            // VTID-VOICE-INIT: Model stopped speaking — ungate mic audio
            session.isModelSpeaking = false;
            // Clear output transcript buffer on interruption (incomplete response)
            session.outputTranscriptBuffer = '';
            session.pendingEventLinks = [];
            // Notify SSE client
            if (session.sseResponse) {
              writeSseEvent(session.sseResponse, { type: 'interrupted' });
            }
            // Notify WS client via callback
            ctx.callbacks.onInterrupted?.();
            return;
          }

          // Check if turn is complete (handle both formats)
          const turnComplete = content.turn_complete || content.turnComplete;
          if (turnComplete) {
            // VTID-WATCHDOG: Model finished turn normally — clear watchdog (waiting for user now)
            ctx.deps.clearResponseWatchdog(session);
            // VTID-VOICE-INIT: Model finished speaking — ungate mic audio
            session.isModelSpeaking = false;
            // VTID-ECHO-COOLDOWN: Record turn completion time for post-turn mic cooldown.
            // Client playback queue may still be draining — gate mic for POST_TURN_COOLDOWN_MS
            // to prevent speaker echo from being picked up and triggering phantom responses.
            session.turnCompleteAt = Date.now();
            console.log(`[VTID-VOICE-INIT] Model stopped speaking for session ${session.sessionId} — mic audio ungated (cooldown ${POST_TURN_COOLDOWN_MS}ms)`);
            ctx.deps.emitDiag(session, 'turn_complete');

            // VTID-02047 voice channel-swap: if a persona swap was queued by
            // the report_to_specialist tool, Vitana has just finished speaking
            // her bridge sentence. Close the upstream WS now (code 1000) — the
            // existing reconnect path will pick up the persona overrides we
            // already set on the session and Devon/Sage/Atlas/Mira will greet
            // in their distinct voice on the new upstream session. The
            // user-facing WS/SSE stays connected through the swap.
            const pendingSwap = (session as any).pendingPersonaSwap;
            if (pendingSwap && session.upstreamWs && session.active) {
              (session as any).activePersona = pendingSwap;
              (session as any).pendingPersonaSwap = null;
              // Set unambiguous flag so close + reconnect handlers know this
              // is a persona swap (vs Vertex 5-min limit, network blip, etc).
              // The flag covers both directions — Vitana → specialist AND
              // specialist → Vitana — without relying on the presence of
              // personaSystemOverride (which is null for back-to-Vitana).
              (session as any)._personaSwapInFlight = true;
              console.log(`[VTID-02047] turn_complete fired with pending persona swap → closing upstream for transparent reconnect to ${pendingSwap}`);
              try {
                session.upstreamWs.close(1000, 'persona_swap');
              } catch (_e) {
                console.warn('[VTID-02047] persona swap close failed:', _e);
              }
              // The close handler at line ~8933 sees code=1000 + session.active
              // and triggers attemptTransparentReconnect → connectToLiveAPI
              // which rebuilds the setup message using personaSystemOverride
              // + personaVoiceOverride + personaForcedFirstMessage (or, for
              // back-to-Vitana, falls through to the default builder since
              // those overrides were cleared by switch_persona).
            }

            session.turn_count++;
            // VTID-LOOPGUARD: Track consecutive model turns without user speech
            session.consecutiveModelTurns++;
            const isGreetingTurn = session.greetingSent && session.turn_count === (session.greetingTurnIndex ?? 0) + 1;
            console.log(`[VTID-01219] Turn complete for session ${session.sessionId} (turn ${session.turn_count}, isGreeting=${isGreetingTurn}, consecutiveModelTurns=${session.consecutiveModelTurns})`);

            // VTID-ANON-SIGNUP-INTENT + VTID-ANON-NUDGE: Detect signup intent and enforce turn limits.
            // CRITICAL: No client_content injections — those cause double responses.
            // All nudging is done via the system instruction (see buildAnonymousSystemInstruction).
            // This block only DETECTS intent and ENDS sessions — it never injects prompts.
            if (session.isAnonymous && !isGreetingTurn) {
              const tc = session.turn_count;

              // Detect signup OR login intent from user's spoken text. Login is
              // distinguished so we can redirect to the correct tab on /maxina.
              const intentText = session.inputTranscriptBuffer.trim();
              if (intentText.length > 0 && !session.signupIntentDetected) {
                const detected = ctx.deps.detectAuthIntent(intentText);
                if (detected) {
                  session.signupIntentDetected = true;
                  session.authIntent = detected;
                  console.log(`[VTID-ANON-AUTH-INTENT] ${detected} intent detected at turn ${tc} for session ${session.sessionId}, text="${intentText.substring(0, 80)}"`);
                } else if (intentText.length > 3) {
                  // Log near-miss so we can refine patterns
                  console.log(`[VTID-ANON-AUTH-INTENT] no match at turn ${tc}, text="${intentText.substring(0, 120)}"`);
                }
              }

              // End session if: auth intent detected OR hard turn limit reached
              if (session.signupIntentDetected || tc > 8) {
                const authIntent = session.authIntent;
                const reason = authIntent
                  ? (authIntent === 'login' ? 'login_intent' : 'signup_intent')
                  : 'turn_limit';
                console.log(`[VTID-ANON-NUDGE] Session ending: reason=${reason}, turn=${tc}, session=${session.sessionId}`);

                const sendLimitMsg = () => {
                  const payload: Record<string, unknown> = {
                    type: 'session_limit_reached',
                    reason,
                    message: reason === 'login_intent'
                      ? 'Guiding to login.'
                      : reason === 'signup_intent'
                        ? 'Guiding to registration.'
                        : 'Please register to continue.',
                  };
                  if (authIntent === 'login') {
                    payload.redirect = '/maxina?tab=signin';
                  } else if (authIntent === 'signup') {
                    payload.redirect = '/maxina?tab=signup';
                  }
                  const limitMsg = JSON.stringify(payload);
                  if (session.sseResponse) {
                    writeSseEvent(session.sseResponse, payload);
                  }
                  if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                    try { ctx.deps.sendWsMessage((session as any).clientWs, JSON.parse(limitMsg)); } catch (_e) { /* ignore */ }
                  }
                };

                sendLimitMsg();
              }
            }

            // VTID-LOOPGUARD: If the model has responded too many times without user input,
            // pause the silence keepalive so Vertex's idle timeout stops the loop naturally.
            if (session.consecutiveModelTurns > MAX_CONSECUTIVE_MODEL_TURNS && !isGreetingTurn) {
              console.warn(`[VTID-LOOPGUARD] Response loop detected for session ${session.sessionId}: ${session.consecutiveModelTurns} consecutive model turns without user speech — pausing silence keepalive`);
              if (session.silenceKeepaliveInterval) {
                clearInterval(session.silenceKeepaliveInterval);
                session.silenceKeepaliveInterval = undefined;
              }
            }

            // VTID-CHAT-BRIDGE: Capture transcript text at turn scope for chat_messages bridge (below)
            let chatBridgeUserText = '';
            let chatBridgeAssistantText = '';

            // VTID-01225-THROTTLE: Flush buffered user input transcription to transcriptTurns + memory_items.
            // Writes once per turn instead of per-fragment, reducing Supabase write amplification.
            if (session.inputTranscriptBuffer.length > 0 && !isGreetingTurn) {
              const userText = session.inputTranscriptBuffer.trim();
              chatBridgeUserText = userText;

              // VTID-01953 — Identity-mutation intent intercept (post-transcription).
              // Vertex Live API streams the LLM response in real time, so we can't
              // pre-empt the model the way conversation-client does. But we can:
              //   1. Detect the explicit identity-mutation intent on the user's
              //      transcript at turn_complete.
              //   2. Push the redirect_target as an SSE event so the frontend
              //      fires the deep-link (open Profile / Settings) — the LLM
              //      can't dispatch CustomEvents on its own.
              //   3. Audit via memory.identity.write_attempted (handled inside
              //      handleIdentityIntent).
              // The brain prompt Guardrail B already shapes the LLM's spoken
              // response to use the sanctioned refusal phrasing, so we don't
              // duplicate the message — just add the deep-link.
              if (session.identity?.user_id && session.identity?.tenant_id) {
                handleIdentityIntent({
                  utterance: userText,
                  user_id: session.identity.user_id,
                  tenant_id: session.identity.tenant_id,
                  source: 'orb-live',
                  conversation_turn_id: session.sessionId,
                }).then((result) => {
                  if (!result.handled) return;
                  console.log(
                    `[VTID-01953] Identity-mutation intent intercepted on ORB voice: ` +
                    `fact_key=${result.detected_fact_key}, pattern="${result.detected_pattern}"`
                  );
                  // Push the redirect-target event to the connected client so the
                  // frontend opens the right screen and focuses the right field.
                  const redirectPayload = {
                    type: 'identity_redirect',
                    redirect_target: result.redirect_target,
                    fact_key: result.detected_fact_key,
                    pattern: result.detected_pattern,
                  };
                  if (session.sseResponse) {
                    writeSseEvent(session.sseResponse, redirectPayload);
                  }
                  if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                    try { ctx.deps.sendWsMessage((session as any).clientWs, redirectPayload); } catch (_e) { /* ignore */ }
                  }
                }).catch((err) => {
                  console.warn('[VTID-01953] handleIdentityIntent failed (non-fatal):', err);
                });
              }

              session.transcriptTurns.push({
                role: 'user',
                text: userText,
                timestamp: new Date().toISOString()
              });
              // VTID-01230: Mirror to session buffer (Tier 0 short-term memory)
              if (session.identity && session.identity.tenant_id && session.identity.user_id) {
                addSessionTurn(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'user', userText);
                // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
                // Fire-and-forget — Redis failure cannot block the ORB voice path.
                addTurnRedis(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'user', userText)
                  .catch(() => { /* logged inside redis-turn-buffer */ });
              }
              // Write to memory_items (single write per turn, not per-fragment)
              let userMemoryIdentity: MemoryIdentity | null = null;
              if (session.identity && session.identity.tenant_id) {
                userMemoryIdentity = {
                  user_id: session.identity.user_id,
                  tenant_id: session.identity.tenant_id
                };
              } else if (ctx.deps.isDevSandbox()) {
                userMemoryIdentity = {
                  user_id: DEV_IDENTITY.USER_ID,
                  tenant_id: DEV_IDENTITY.TENANT_ID
                };
              }
              if (userMemoryIdentity && userText.length > 20) {
                writeMemoryItemWithIdentity(userMemoryIdentity, {
                  source: 'orb_voice',
                  content: userText,
                  content_json: {
                    direction: 'user',
                    channel: 'orb',
                    mode: 'live_voice',
                    orb_session_id: session.sessionId,
                    conversation_id: session.conversation_id
                  },
                }).catch(err => console.warn(`[VTID-01225-THROTTLE] Failed to write user transcript to memory: ${err.message}`));
              }
            }
            session.inputTranscriptBuffer = '';

            // VTID-LINK-INJECT: Append pending event links to output transcript
            // The AI is instructed not to say URLs aloud, so we inject them into the text transcript
            // so they appear in the user's chat as clickable links.
            // Only inject links for events the AI actually referenced in its spoken response.
            if (session.pendingEventLinks.length > 0) {
              // Deduplicate by URL
              const seen = new Set<string>();
              const allLinks = session.pendingEventLinks.filter(p => {
                if (seen.has(p.url)) return false;
                seen.add(p.url);
                return true;
              });

              // Filter: only include events the AI actually mentioned by checking title words
              // against the spoken transcript. If AI mentioned none (edge case), include all.
              const spokenText = session.outputTranscriptBuffer.toLowerCase();
              const mentionedLinks = allLinks.filter(p => {
                if (!p.title) return true; // no title = fallback URL, always include
                // Check if significant words from the title appear in the spoken response
                const words = p.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                return words.some(w => spokenText.includes(w));
              });
              const linksToInject = mentionedLinks.length > 0 ? mentionedLinks : allLinks;

              // Format as a numbered list with titles
              let formattedBlock: string;
              if (linksToInject.length === 1) {
                // Single link: just title + URL
                const p = linksToInject[0];
                formattedBlock = p.title
                  ? `\n\n${p.title}\n${p.url}`
                  : `\n\n${p.url}`;
              } else {
                // Multiple links: numbered list
                const listItems = linksToInject.map((p, i) =>
                  p.title ? `${i + 1}. ${p.title}\n   ${p.url}` : `${i + 1}. ${p.url}`
                );
                formattedBlock = `\n\n${listItems.join('\n\n')}`;
              }

              session.outputTranscriptBuffer += formattedBlock;
              console.log(`[VTID-LINK-INJECT] Injected ${linksToInject.length}/${allLinks.length} event link(s) into output transcript`);

              // Send the formatted block as a single output_transcript SSE event
              if (session.sseResponse) {
                writeSseEvent(session.sseResponse, { type: 'output_transcript', text: formattedBlock });
              }
              if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                try { ctx.deps.sendWsMessage(session.clientWs, { type: 'output_transcript', text: formattedBlock }); } catch (_e) { /* WS closed */ }
              }
              session.pendingEventLinks = [];
            }

            // VTID-01225: Write accumulated assistant transcript to memory_items and transcriptTurns
            // Skip memory write for the greeting turn (server-injected prompt, not real user interaction)
            if (session.outputTranscriptBuffer.length > 0) {
              const fullTranscript = session.outputTranscriptBuffer.trim();
              chatBridgeAssistantText = fullTranscript;

              // Forwarding v2d: the FORCED FIRST UTTERANCE flag MUST flip even
              // for the greeting turn — that IS the forced utterance. Setting
              // it inside the `else` branch (greeting-turn = false) was the
              // bug: every transparent reconnect re-applied the greeting
              // because the flag never got set on Devon's actual greeting.
              if ((session as any).personaForcedFirstMessage
                  && !((session as any).personaFirstUtteranceDelivered as boolean | undefined)) {
                (session as any).personaFirstUtteranceDelivered = true;
              }

              if (isGreetingTurn) {
                console.log(`[VTID-VOICE-INIT] Skipping memory write for greeting turn: "${fullTranscript.substring(0, 80)}..."`);
                // Forwarding v2d: still record greeting turns in
                // transcriptTurns so the conversation_history that gets
                // injected into a swapped persona's prompt shows what was
                // already said. Without this, a specialist's greeting line
                // (e.g. "Hi I'm Devon, what's the bug?") is missing from
                // history when the user hands back to Vitana — and the model
                // can fill the gap by inventing it in Vitana's voice.
                session.transcriptTurns.push({
                  role: 'assistant',
                  text: fullTranscript,
                  timestamp: new Date().toISOString(),
                  persona: ((session as any).activePersona as string | undefined) || 'vitana',
                });
              } else {
                console.log(`[VTID-01225] Writing assistant turn to memory: "${fullTranscript.substring(0, 100)}..."`);

                // Add to transcriptTurns for in-memory accumulation, recording
                // which persona spoke this turn so downstream prompt builders
                // can label it correctly (otherwise Vitana absorbs Devon's
                // lines as her own past speech — the "Hi I'm Devon in Vitana
                // voice" failure).
                session.transcriptTurns.push({
                  role: 'assistant',
                  text: fullTranscript,
                  timestamp: new Date().toISOString(),
                  persona: ((session as any).activePersona as string | undefined) || 'vitana',
                });

                // Forwarding v2 anti-impersonation guard: detect if this
                // utterance impersonates a different persona ("I am Devon"
                // spoken by anyone NOT Devon, etc). One offense = log +
                // inject a corrective directive into the upstream. Two
                // offenses in a row = hard reconnect with persona override
                // re-applied.
                try {
                  const activePersonaForCheck = ((session as any).activePersona as string | undefined) || 'vitana';
                  const PERSONA_KEYS = ['vitana', 'devon', 'sage', 'atlas', 'mira'];
                  const IMPERSONATION_RE = /\b(?:I(?:'?m| am)|this is|here(?:'?s| is)|on behalf of|me, |it'?s)\s+(vitana|devon|sage|atlas|mira)\b/i;
                  const m = fullTranscript.match(IMPERSONATION_RE);
                  if (m) {
                    const claimed = m[1].toLowerCase();
                    if (PERSONA_KEYS.includes(claimed) && claimed !== activePersonaForCheck) {
                      const driftCount = (((session as any).identityDriftCount as number | undefined) ?? 0) + 1;
                      (session as any).identityDriftCount = driftCount;
                      console.warn(`[VTID-02670] Identity drift detected: active=${activePersonaForCheck}, claimed=${claimed}, count=${driftCount}, utterance="${fullTranscript.substring(0,120)}"`);
                      // Best-effort OASIS log (non-blocking).
                      import('../../../services/oasis-event-service').then(({ emitOasisEvent }) => {
                        emitOasisEvent({
                          vtid: 'VTID-02670',
                          type: 'orb.persona.identity_drift' as any,
                          source: 'orb-live',
                          status: driftCount > 1 ? 'error' : 'warning',
                          message: `${activePersonaForCheck} introduced themselves as ${claimed}`,
                          payload: {
                            session_id: session.sessionId,
                            active_persona: activePersonaForCheck,
                            claimed_persona: claimed,
                            drift_count: driftCount,
                            utterance: fullTranscript.substring(0, 500),
                          },
                          actor_id: session.identity?.user_id,
                          actor_role: 'system',
                          surface: 'orb',
                          vitana_id: session.identity?.vitana_id ?? undefined,
                        });
                      }).catch(() => undefined);
                      // On REPEAT drift, force-reconnect with the persona
                      // override re-applied. The setup-message builder picks
                      // up the latest persona state on the new connection.
                      if (driftCount >= 2 && session.upstreamWs) {
                        console.warn(`[VTID-02670] Forcing hard reconnect to re-anchor persona ${activePersonaForCheck}`);
                        (session as any)._personaSwapInFlight = true;
                        try { session.upstreamWs.close(); } catch { /* ignore */ }
                      }
                    }
                  }
                } catch { /* non-blocking */ }

                // VTID-01230: Mirror to session buffer (Tier 0 short-term memory)
                if (session.identity && session.identity.tenant_id && session.identity.user_id) {
                  addSessionTurn(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'assistant', fullTranscript);
                  // VTID-01955: Dual-write to Memorystore Redis (multi-instance shared).
                  addTurnRedis(session.sessionId, session.identity.tenant_id, session.identity.user_id, 'assistant', fullTranscript)
                    .catch(() => { /* logged inside redis-turn-buffer */ });
                }

                // Write to memory_items for persistence
                // Use session identity if available, otherwise fall back to DEV_IDENTITY in dev-sandbox
                let memoryIdentity: MemoryIdentity | null = null;
                if (session.identity && session.identity.tenant_id) {
                  memoryIdentity = {
                    user_id: session.identity.user_id,
                    tenant_id: session.identity.tenant_id
                  };
                } else if (ctx.deps.isDevSandbox()) {
                  console.log(`[VTID-01225] No session identity, using DEV_IDENTITY fallback`);
                  memoryIdentity = {
                    user_id: DEV_IDENTITY.USER_ID,
                    tenant_id: DEV_IDENTITY.TENANT_ID
                  };
                } else {
                  console.warn(`[VTID-01225] Cannot write to memory: no identity and not dev-sandbox`);
                }

                // VTID-01225-CLEANUP: Do NOT write assistant responses to memory_items.
                // Assistant output is derivative (generated from user input + system prompt).
                // Storing it causes pollution — "nice to meet you", "let me help you with that", etc.
                // User facts are extracted to memory_facts via inline-fact-extractor instead.
                if (memoryIdentity) {
                  console.log(`[VTID-01225-CLEANUP] Skipping assistant transcript write to memory_items (pollution prevention)`);
                }
              }

              // Clear buffer for next turn
              session.outputTranscriptBuffer = '';
            }

            // VTID-CHAT-BRIDGE: Write voice transcripts to chat_messages so they appear
            // as a Vitana DM conversation. Fire-and-forget to avoid blocking the voice pipeline.
            // Explicit created_at timestamps ensure user message always sorts before Vitana reply.
            if (session.identity?.user_id && session.identity?.tenant_id) {
              const bridgeSupabase = getSupabase();
              if (bridgeSupabase) {
                const bridgeUserId = session.identity.user_id;
                const bridgeTenantId = session.identity.tenant_id;
                const bridgeMeta = {
                  orb_session_id: session.sessionId,
                  turn_index: session.turn_count,
                  voice_language: session.lang,
                };
                const userMsgTime = new Date();
                const assistantMsgTime = new Date(userMsgTime.getTime() + 1); // +1ms ensures correct sort order

                // User speech → chat_messages (sender=user, receiver=Vitana)
                if (chatBridgeUserText.length > 0) {
                  bridgeSupabase.from('chat_messages').insert({
                    tenant_id: bridgeTenantId,
                    sender_id: bridgeUserId,
                    receiver_id: VITANA_BOT_USER_ID,
                    content: chatBridgeUserText,
                    message_type: 'voice_transcript',
                    metadata: { ...bridgeMeta, direction: 'user_to_vitana' },
                    created_at: userMsgTime.toISOString(),
                  }).then(({ error }) => {
                    if (error) console.warn(`[VTID-CHAT-BRIDGE] User transcript write failed: ${error.message}`);
                  });
                }

                // Vitana speech → chat_messages (sender=Vitana, receiver=user)
                // Pre-set read_at since user already heard this during the voice session
                if (chatBridgeAssistantText.length > 0) {
                  bridgeSupabase.from('chat_messages').insert({
                    tenant_id: bridgeTenantId,
                    sender_id: VITANA_BOT_USER_ID,
                    receiver_id: bridgeUserId,
                    content: chatBridgeAssistantText,
                    message_type: 'voice_transcript',
                    metadata: { ...bridgeMeta, direction: 'vitana_to_user', is_greeting: isGreetingTurn },
                    read_at: assistantMsgTime.toISOString(),
                    created_at: assistantMsgTime.toISOString(),
                  }).then(({ error }) => {
                    if (error) console.warn(`[VTID-CHAT-BRIDGE] Vitana transcript write failed: ${error.message}`);
                  });
                }
              }
            }

            // VTID-01225-THROTTLE: Incremental fact extraction — throttled to max once per 60s.
            // Fires a separate Vertex AI generateContent call, so running it on every turn
            // creates concurrent API calls that can hit rate limits and destabilize the
            // Live API WebSocket. The 60s throttle preserves durability (facts survive
            // disconnects) without hammering the API during active conversation.
            const EXTRACTION_THROTTLE_MS = 60_000;
            // VTID-01230: Deduplicated extraction replaces manual throttle logic
            // VTID-NAV: When a navigation is queued, force the extraction so the
            // last turn before session close always contributes to memory facts.
            if (session.identity && session.identity.tenant_id) {
              const recentTurns = session.transcriptTurns.slice(-4);
              if (recentTurns.length > 0) {
                const recentText = recentTurns
                  .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
                  .join('\n');
                deduplicatedExtract({
                  conversationText: recentText,
                  tenant_id: session.identity.tenant_id,
                  user_id: session.identity.user_id,
                  session_id: session.sessionId,
                  turn_count: session.turn_count,
                  force: !!session.pendingNavigation,
                });
              }
            }

            // VTID-NAV: Dispatch the orb_directive for any pending navigation.
            // This MUST come AFTER the memory flush, chat_messages bridge, and
            // fact extractor above so the navigation turn's memory writes are
            // committed before the widget tears down the session.
            if (session.pendingNavigation) {
              const nav = session.pendingNavigation;
              const directive = {
                type: 'orb_directive',
                directive: 'navigate',
                screen_id: nav.screen_id,
                route: nav.route,
                title: nav.title,
                reason: nav.reason,
                vtid: 'VTID-NAV-01',
              };
              if (session.sseResponse) {
                writeSseEvent(session.sseResponse, directive);
              }
              if ((session as any).clientWs && (session as any).clientWs.readyState === WebSocket.OPEN) {
                try { ctx.deps.sendWsMessage((session as any).clientWs, directive); } catch (_e) { /* WS closed */ }
              }
              console.log(`[VTID-NAV-01] orb_directive dispatched: navigate to ${nav.screen_id} (${nav.route}) — session=${session.sessionId}`);
              emitOasisEvent({
                vtid: 'VTID-NAV-01',
                type: 'orb.navigator.dispatched',
                source: 'orb-live-ws',
                status: 'info',
                message: `dispatched navigate to ${nav.screen_id}`,
                payload: {
                  session_id: session.sessionId,
                  screen_id: nav.screen_id,
                  route: nav.route,
                  decision_source: nav.decision_source,
                  drain_wait_ms: Date.now() - nav.requested_at,
                },
              }).catch(() => {});
              // Clear pending so we don't re-dispatch on subsequent turns.
              // navigationDispatched stays TRUE so input audio stays gated until
              // the widget closes the connection.
              session.pendingNavigation = undefined;
            } else {
              // VTID-NAV-DIAG: turn_complete fired but no navigation was queued.
              // This is what "stuck in listening after asking for redirect" looks
              // like server-side. If we see this log line after a user asked for
              // a redirect, it means Gemini never called navigate_to_screen.
              console.log(`[VTID-NAV-DIAG] turn_complete for session ${session.sessionId}: NO pendingNavigation (navigationDispatched=${!!session.navigationDispatched}, consecutiveToolCalls=${session.consecutiveToolCalls}) — widget will transition to listening`);
            }

            // Notify client that response is complete
            if (session.sseResponse) {
              writeSseEvent(session.sseResponse, {
                type: 'turn_complete',
                is_greeting: isGreetingTurn,
              });
            }
            // Notify WS client via callback
            ctx.callbacks.onTurnComplete?.();
            return;
          }

          // Process model turn content (handle both formats)
          const modelTurn = content.model_turn || content.modelTurn;
          if (modelTurn && modelTurn.parts) {
            for (const part of modelTurn.parts) {
              // Handle audio response (handle both formats)
              const inlineData = part.inline_data || part.inlineData;
              const mimeType = inlineData?.mime_type || inlineData?.mimeType;
              if (inlineData && mimeType?.startsWith('audio/')) {
                // VTID-NAV-HOTFIX: Once navigation is queued, drop ALL further
                // audio from Gemini. After navigate_to_screen fires, Gemini's
                // tool-use protocol FORCES a model response to the
                // function_response — that response IS a second (Turn 2) audio
                // stream that would arrive at the widget before Turn 1's
                // turn_complete and overlap the transition sentence the user
                // is already hearing. The flag is set synchronously inside
                // handleNavigateToScreen BEFORE sendFunctionResponseToLiveAPI
                // is called, so by the time Gemini even produces Turn 2 audio,
                // this gate is already armed.
                if (session.navigationDispatched) {
                  session.audioOutChunks++;
                  if (session.audioOutChunks % 50 === 1) {
                    console.log(`[VTID-NAV-HOTFIX] Dropping post-nav audio chunk ${session.audioOutChunks} for session ${session.sessionId}`);
                  }
                  continue;
                }
                // VTID-VOICE-INIT: Mark model as speaking on first audio chunk
                // This gates inbound mic audio to prevent echo-triggered interruptions
                if (!session.isModelSpeaking) {
                  session.isModelSpeaking = true;
                  // VTID-TOOLGUARD: Model produced audio — reset tool call counter
                  session.consecutiveToolCalls = 0;
                  // VTID-01984 (R5): Vertex has spoken — upstream WS is healthy.
                  // Once true, the audio-forwarding paths skip arming the
                  // forwarding_no_ack watchdog so we never kill a healthy
                  // session in the middle of Vertex computing a follow-up turn.
                  session.vertexHasShownLife = true;
                  console.log(`[VTID-VOICE-INIT] Model started speaking for session ${session.sessionId} — mic audio gated`);
                  ctx.deps.emitDiag(session, 'model_start_speaking');
                  // BOOTSTRAP-ORB-HOTFIX-1: If this is the greeting (no turns yet
                  // and greeting was sent), emit the pre-greeting latency gauge.
                  //
                  // BOOTSTRAP-ORB-RELIABILITY-R2: Log gate evaluation so we can
                  // debug why the prior gauge version emitted zero events. All
                  // three booleans are logged so we can spot which guard is
                  // falsifying the condition in prod.
                  const gateGreeting = !!session.greetingSent;
                  const gateTurnZero = session.turn_count === 0;
                  const gateNoChunks = !session.audioOutChunks;
                  console.log(`[BOOTSTRAP-ORB-HOTFIX-1-GATE] session=${session.sessionId} greetingSent=${gateGreeting} turn_count=${session.turn_count} audioOutChunks=${session.audioOutChunks}`);
                  if (gateGreeting && gateTurnZero && gateNoChunks) {
                    const preGreetingMs = Date.now() - session.createdAt.getTime();
                    ctx.deps.emitLiveSessionEvent('orb.live.greeting.delivered', {
                      session_id: session.sessionId,
                      user_id: session.identity?.user_id || 'anonymous',
                      tenant_id: session.identity?.tenant_id || null,
                      transport: session.clientWs ? 'websocket' : 'sse',
                      pre_greeting_ms: preGreetingMs,
                      lang: session.lang,
                      is_anonymous: session.isAnonymous || false,
                      reconnect_count: (session as any)._reconnectCount || 0,
                    }).catch((err: any) => {
                      console.warn(`[BOOTSTRAP-ORB-HOTFIX-1] emit failed: ${err?.message || err}`);
                    });
                    console.log(`[BOOTSTRAP-ORB-HOTFIX-1] pre_greeting_ms=${preGreetingMs} for session ${session.sessionId}`);
                  }
                }
                // VTID-WATCHDOG: Model is sending audio — restart watchdog.
                // If audio stops mid-stream (no turn_complete), watchdog fires.
                ctx.deps.startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'audio_stall');
                session.audioOutChunks++;
                const audioB64 = inlineData.data;
                // VTID-STREAM-KEEPALIVE: Only log every 50th audio chunk to reduce log volume
                if (session.audioOutChunks % 50 === 1) {
                  console.log(`[VTID-01219] Audio chunk ${session.audioOutChunks}, size: ${audioB64.length}`);
                }
                ctx.callbacks.onAudioResponse(audioB64);

                // VTID-STREAM-KEEPALIVE: Removed per-chunk OASIS event emission.
                // emitLiveSessionEvent fires an HTTP call to Supabase on every audio chunk
                // (dozens per second). This creates massive I/O pressure and slows the event loop.
                // Audio stats are logged at session stop instead.
              }

              // Handle text response
              if (part.text) {
                // VTID-WATCHDOG: Model is responding with text — restart watchdog.
                // If text stops mid-stream (no turn_complete), watchdog fires.
                ctx.deps.startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'text_stall');
                console.log(`[VTID-01219] Received text: ${part.text.substring(0, 100)}`);
                ctx.callbacks.onTextResponse(part.text);
              }
            }
          }

          // Handle input/output transcriptions if present (handle both formats)
          // VTID-01225: Gemini returns transcription as object with .text property
          const inputTransObj = content.input_transcription || content.inputTranscription;
          const outputTransObj = content.output_transcription || content.outputTranscription;
          // Debug: Log raw transcription objects to understand Gemini response format
          if (inputTransObj || outputTransObj) {
            console.log(`[VTID-01225] Raw transcription objects - input: ${JSON.stringify(inputTransObj)}, output: ${JSON.stringify(outputTransObj)}`);
          }
          // Extract text - handle both object format (.text) and direct string format
          const inputTranscription = typeof inputTransObj === 'string' ? inputTransObj : inputTransObj?.text;
          const outputTranscription = typeof outputTransObj === 'string' ? outputTransObj : outputTransObj?.text;
          if (inputTranscription) {
            // Filter out the server-injected greeting prompt from transcription/memory
            const isGreetingPrompt = session.greetingSent && session.turn_count === 0 &&
              (inputTranscription.includes('greet the user') || inputTranscription.includes('begrüße den Benutzer'));
            if (isGreetingPrompt) {
              console.log(`[VTID-VOICE-INIT] Filtering greeting prompt from input transcription: "${inputTranscription.substring(0, 60)}..."`);
            } else {
              console.log(`[VTID-01219] Input transcription: ${inputTranscription}`);
              // VTID-01984 (R5): Vertex's VAD fired and produced a transcription —
              // upstream WS is demonstrably healthy. Mark life signal so subsequent
              // user-audio chunks don't arm the forwarding_no_ack watchdog (which
              // was destroying healthy sessions when first-turn inference exceeded
              // 15 s). Real WS failures are still caught by native handlers.
              session.vertexHasShownLife = true;
              ctx.deps.emitDiag(session, 'input_transcription', { text_preview: inputTranscription.substring(0, 80) });
              if (session.sseResponse) {
                writeSseEvent(session.sseResponse, { type: 'input_transcript', text: inputTranscription });
              }
              // VTID-01225-THROTTLE: Buffer user input transcription instead of writing per-fragment.
              // Vertex Live API sends transcription incrementally (multiple fragments per utterance).
              // Writing per-fragment caused N parallel Supabase requests per sentence. Now we
              // accumulate in inputTranscriptBuffer and write once at turn_complete.
              session.inputTranscriptBuffer += (session.inputTranscriptBuffer ? ' ' : '') + inputTranscription;

              // VTID-LOOPGUARD: User spoke — reset consecutive model turn counter
              session.consecutiveModelTurns = 0;
              // VTID-TOOLGUARD: User spoke — reset consecutive tool call counter
              session.consecutiveToolCalls = 0;
              // VTID-LOOPGUARD: Re-enable silence keepalive if it was paused
              if (!session.silenceKeepaliveInterval && session.upstreamWs) {
                session.silenceKeepaliveInterval = setInterval(() => {
                  if (!session.upstreamWs || session.upstreamWs.readyState !== WebSocket.OPEN || !session.active) return;
                  if (session.isModelSpeaking) return;
                  const idleMs = Date.now() - session.lastAudioForwardedTime;
                  if (idleMs >= SILENCE_IDLE_THRESHOLD_MS) {
                    try {
                      ctx.deps.sendAudioToLiveAPI(session.upstreamWs, SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
                    } catch (_e) { /* WS closing */ }
                  }
                }, SILENCE_KEEPALIVE_INTERVAL_MS);
              }

              // VTID-WATCHDOG: User spoke — start watchdog waiting for model response.
              // Restart on each transcript fragment to give the model time from the
              // LAST user speech, not the first (user may still be speaking).
              ctx.deps.startResponseWatchdog(session, TURN_RESPONSE_TIMEOUT_MS, 'response_timeout');

              // VTID-THINKING: Notify client that model is processing (user spoke, waiting for response).
              // Client uses this to show "Thinking..." state instead of staying on "Listening...".
              if (!session.isModelSpeaking) {
                const thinkingMsg = { type: 'thinking' };
                if (session.sseResponse) {
                  writeSseEvent(session.sseResponse, thinkingMsg);
                }
                if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                  try { ctx.deps.sendWsMessage(session.clientWs, thinkingMsg); } catch (_e) { /* WS closed */ }
                }
              }
            }
          }
          if (outputTranscription) {
            // VTID-NAV-HOTFIX: Drop Turn 2 transcription the same way we drop
            // Turn 2 audio. Without this, memory + chat bridge would capture
            // the post-nav model response even though the user never heard it.
            if (session.navigationDispatched) {
              console.log(`[VTID-NAV-HOTFIX] Dropping post-nav output transcription: "${outputTranscription.substring(0, 60)}..."`);
            } else {
              console.log(`[VTID-01219] Output transcription: ${outputTranscription}`);
              if (session.sseResponse) {
                writeSseEvent(session.sseResponse, { type: 'output_transcript', text: outputTranscription });
              }
              // VTID-01225: Accumulate output transcription chunks in buffer (will be written on turnComplete)
              session.outputTranscriptBuffer += outputTranscription;
            }
          }
        }

        // VTID-01224: Handle tool calls (function calling) - execute and respond
        const toolCall = message.tool_call || message.toolCall;
        if (toolCall) {
          const toolNames = (toolCall.function_calls || toolCall.functionCalls || []).map((fc: any) => fc.name);
          session.consecutiveToolCalls++;
          console.log(`[VTID-01224] Tool call received for session ${session.sessionId} (consecutive: ${session.consecutiveToolCalls}/${MAX_CONSECUTIVE_TOOL_CALLS}):`, JSON.stringify(toolCall).substring(0, 500));
          ctx.deps.emitDiag(session, 'tool_call', { tools: toolNames, consecutive: session.consecutiveToolCalls });

          // VTID-THINKING: Notify client that model is processing a tool call.
          // Shows "Thinking..." while memory search, event search etc. execute.
          const toolThinkingMsg = { type: 'thinking', reason: 'tool_call', tools: toolNames };
          if (session.sseResponse) {
            writeSseEvent(session.sseResponse, toolThinkingMsg);
          }
          if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
            try { ctx.deps.sendWsMessage(session.clientWs, toolThinkingMsg); } catch (_e) { /* WS closed */ }
          }

          // Extract function calls (handle both formats)
          const functionCalls = toolCall.function_calls || toolCall.functionCalls || [];

          // VTID-TOOLGUARD: If too many consecutive tool calls without audio,
          // we break the loop by sending synthetic responses that instruct
          // Gemini to answer with data already gathered. Previously we silently
          // DROPPED the responses — but that left Gemini blocked waiting on
          // function_responses that never arrived, producing zombie upstream
          // sessions (no input_transcription, no audio) and ultimately
          // `watchdog_fired` with reason `forwarding_no_ack`. Sending a
          // synthetic response keeps the Live API protocol intact while still
          // forcing the model out of the tool-call loop.
          if (session.consecutiveToolCalls > MAX_CONSECUTIVE_TOOL_CALLS) {
            console.warn(`[VTID-TOOLGUARD] Tool call loop detected for session ${session.sessionId}: ${session.consecutiveToolCalls} consecutive calls (limit: ${MAX_CONSECUTIVE_TOOL_CALLS}). Sending synthetic loop-break response.`);
            ctx.deps.emitDiag(session, 'tool_loop_guard', { consecutive: session.consecutiveToolCalls, dropped_tools: toolNames });
            ctx.deps.emitLiveSessionEvent('orb.live.tool_loop_guard_activated', {
              session_id: session.sessionId,
              consecutive: session.consecutiveToolCalls,
              tools: toolNames,
              function_call_count: functionCalls.length,
            }, 'warning').catch(() => { });
            for (const fc of functionCalls) {
              const callId = fc.id || randomUUID();
              ctx.deps.sendFunctionResponseToLiveAPI(ws, callId, fc.name, {
                success: false,
                result: '',
                error: 'Tool loop guard: too many consecutive tool calls. Respond to the user now with the information already gathered from earlier tool results. Do not call any more tools in this turn.',
              });
            }
          } else {
            for (const fc of functionCalls) {
            const toolName = fc.name;
            const toolArgs = fc.args || {};
            const callId = fc.id || randomUUID();

            console.log(`[VTID-01224] Executing tool: ${toolName} with args: ${JSON.stringify(toolArgs)}`);

            // Execute the tool asynchronously
            const toolStartTime = Date.now();
            ctx.deps.executeLiveApiTool(session, toolName, toolArgs)
              .then((result) => {
                const toolElapsed = Date.now() - toolStartTime;
                console.log(`[VTID-01224] Tool ${toolName} completed in ${toolElapsed}ms, success=${result.success}, resultLen=${result.result.length}`);

                // VTID-LINK: Extract title+URL pairs from tool results and send to client.
                // Vitana won't say URLs in voice, so we push them to chat via SSE/WS.
                // Tool results are formatted as "Title | Date | Location | ... | Link: URL"
                if (result.success && result.result) {
                  const linkPairs: { title: string; url: string }[] = [];
                  const lines = result.result.split('\n');
                  for (const line of lines) {
                    const linkMatch = line.match(/\| Link: (https?:\/\/[^\s|]+)/);
                    if (linkMatch) {
                      const url = linkMatch[1];
                      const title = line.split('|')[0].trim();
                      if (url && title && !linkPairs.some(p => p.url === url)) {
                        linkPairs.push({ title, url });
                      }
                    }
                  }
                  // Fallback: extract any remaining URLs not captured by the structured format
                  if (linkPairs.length === 0) {
                    const urlRegex = /https?:\/\/[^\s"',)}\]]+/g;
                    const urls = result.result.match(urlRegex);
                    if (urls) {
                      for (const url of [...new Set(urls)] as string[]) {
                        if (!linkPairs.some(p => p.url === url)) {
                          linkPairs.push({ title: '', url });
                        }
                      }
                    }
                  }
                  if (linkPairs.length > 0) {
                    for (const { url } of linkPairs) {
                      const linkMsg = { type: 'link', url, tool: toolName };
                      if (session.sseResponse) {
                        writeSseEvent(session.sseResponse, linkMsg);
                      }
                      if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
                        try { ctx.deps.sendWsMessage(session.clientWs, linkMsg); } catch (_e) { /* WS closed */ }
                      }
                    }
                    console.log(`[VTID-LINK] Sent ${linkPairs.length} link(s) to client from ${toolName}: ${linkPairs.map(p => p.url).join(', ')}`);
                    // VTID-LINK-INJECT: Store title+URL pairs for injection into output transcript at turn_complete
                    session.pendingEventLinks.push(...linkPairs);
                  }
                }

                // Send response back to Live API
                const sent = ctx.deps.sendFunctionResponseToLiveAPI(ws, callId, toolName, result);
                if (!sent) {
                  console.error(`[VTID-01224] function_response NOT sent for ${toolName} — WebSocket no longer open. Session ${session.sessionId} may be stalled.`);
                }

                // Emit OASIS event for tool execution
                emitOasisEvent({
                  vtid: 'VTID-01224',
                  type: 'orb.live.tool.executed',
                  source: 'orb-live-ws',
                  status: result.success ? 'info' : 'warning',
                  message: `Tool ${toolName} executed in ${toolElapsed}ms: ${result.success ? 'success' : 'failed'}`,
                  payload: {
                    session_id: session.sessionId,
                    tool_name: toolName,
                    tool_args: toolArgs,
                    success: result.success,
                    result_length: result.result.length,
                    elapsed_ms: toolElapsed,
                    response_sent: sent,
                    result_preview: result.result.substring(0, 200),
                    error: result.error || null,
                  },
                }).catch(() => { });
              })
              .catch((err) => {
                const toolElapsed = Date.now() - toolStartTime;
                console.error(`[VTID-01224] Tool ${toolName} threw after ${toolElapsed}ms:`, err);
                ctx.deps.sendFunctionResponseToLiveAPI(ws, callId, toolName, {
                  success: false,
                  result: '',
                  error: err.message,
                });
              });
            }
          } // end else (tool guard)
        }

      } catch (err) {
        console.error(`[VTID-01219] Error parsing Live API message:`, err);
      }
    }

  return handleUpstreamLiveMessage;
}
