/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 6): WebSocket-shaped facade over an
 * `UpstreamLiveClient`.
 *
 * The ORB session engine (greeting decision engine, sync-flow nudges,
 * stall recovery, WS/SSE input handlers) sends upstream traffic through
 * `session.upstreamWs` using the Vertex BidiGenerateContent wire envelopes
 * (`realtime_input`, `client_content`). Rather than teach every one of
 * those call sites about a second provider, this facade presents the
 * minimal `ws`-like surface they use (`readyState`, `send`, `close`,
 * `ping`, `terminate`) and translates each outbound envelope into the
 * provider-neutral `UpstreamLiveClient` call:
 *
 *   realtime_input.media_chunks[]           → sendAudioChunk (b64 passthrough)
 *   client_content.turns[].parts[].text     → sendTextTurn
 *   client_content.turn_complete (no turns) → sendEndOfTurn
 *   close(code, reason) / terminate()       → close(reason)
 *   ping()                                  → no-op (no WS transport under it)
 *
 * `tool_response` envelopes are refused with a warning — tool results MUST
 * flow through the session binding's `client.sendToolResult` (correlated
 * by callId; Nova stalls on an uncorrelated result).
 *
 * Inbound events do NOT flow through this facade — the session registers
 * typed handlers via `bindUpstreamSessionHandlers`. The `on*` registration
 * methods exist only so legacy code that defensively attaches listeners
 * does not crash; they are inert.
 */

import type { UpstreamLiveClient } from './types';

const WS_OPEN = 1;
const WS_CLOSED = 3;

export interface NovaWsFacade {
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(): void;
  once(): void;
  removeListener(): void;
  removeAllListeners(): void;
  /** Marker so diagnostics can tell facade from real socket. */
  readonly __novaFacade: true;
}

export function createNovaWsFacade(client: UpstreamLiveClient): NovaWsFacade {
  return {
    __novaFacade: true,

    get readyState(): number {
      return client.getState() === 'open' ? WS_OPEN : WS_CLOSED;
    },

    send(payload: string): void {
      let msg: any;
      try {
        msg = JSON.parse(payload);
      } catch {
        console.warn('[BOOTSTRAP-NOVA-SONIC-VOICE] facade dropped non-JSON upstream payload');
        return;
      }

      const media = msg?.realtime_input?.media_chunks;
      if (Array.isArray(media) && media.length > 0) {
        for (const chunk of media) {
          if (chunk && typeof chunk.data === 'string') {
            client.sendAudioChunk(chunk.data, chunk.mime_type);
          }
        }
        return;
      }

      const cc = msg?.client_content;
      if (cc) {
        const texts: string[] = [];
        for (const turn of cc.turns ?? []) {
          for (const part of turn?.parts ?? []) {
            if (typeof part?.text === 'string' && part.text.length > 0) texts.push(part.text);
          }
        }
        if (texts.length > 0) {
          client.sendTextTurn(texts.join('\n'), cc.turn_complete !== false);
          return;
        }
        if (cc.turn_complete) {
          client.sendEndOfTurn();
          return;
        }
        return;
      }

      if (msg?.tool_response) {
        console.warn(
          '[BOOTSTRAP-NOVA-SONIC-VOICE] facade refused tool_response — tool results must go through client.sendToolResult (callId correlation)',
        );
        return;
      }

      console.warn(
        `[BOOTSTRAP-NOVA-SONIC-VOICE] facade dropped unrecognized upstream envelope: keys=${Object.keys(msg ?? {}).join(',')}`,
      );
    },

    close(_code?: number, reason?: string): void {
      void client.close(reason).catch(() => { /* idempotent */ });
    },

    terminate(): void {
      void client.close('terminated').catch(() => { /* idempotent */ });
    },

    ping(): void {
      /* no WS transport underneath — Bedrock HTTP/2 needs no app-level ping */
    },

    on(): void { /* inert — inbound events flow via bindUpstreamSessionHandlers */ },
    once(): void { /* inert */ },
    removeListener(): void { /* inert */ },
    removeAllListeners(): void { /* inert */ },
  };
}
