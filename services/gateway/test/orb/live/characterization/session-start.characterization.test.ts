/**
 * A0.2 — Characterization test for the /live/session/start request contract.
 *
 * Purpose: lock the body-field contract that the session-start route handler
 * reads, plus the inline reconnect-detection formula. Both are about to
 * move when A8 extracts session lifecycle into orb/live/session/.
 *
 * Approach: structural assertions over orb-live.ts source text. The route
 * handler is too entangled with Express + auth + Supabase + Live API to
 * mock cleanly in a "tests-only" PR. The structural form catches the
 * regressions that matter for the refactor:
 *   - lost body field (a UI sends X but the new handler doesn't read X)
 *   - shifted reconnect detection (subtle change to the boolean formula)
 *   - dropped reconnect_stage value from the validation list
 *
 * When A8 produces a typed RequestParser module, this test should be
 * replaced with a runtime assertion against that parser.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let source: string;
let handlerBody: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  // Slice the file from the route registration down to the next route or
  // top-level export. `router.post('/live/session/stop'` is the next route
  // in the file and serves as a safe terminator.
  const startIdx = source.indexOf("router.post('/live/session/start'");
  const stopIdx = source.indexOf("router.post('/live/session/stop'");
  expect(startIdx).toBeGreaterThan(0);
  expect(stopIdx).toBeGreaterThan(startIdx);
  handlerBody = source.slice(startIdx, stopIdx);
});

describe('A0.2 characterization: /live/session/start request contract', () => {
  describe('body fields the handler reads', () => {
    // These are the LiveSessionStartRequest fields the current handler
    // pulls off req.body. Every UI surface (vitana-v1, Command Hub orb-widget,
    // mobile WebView) is observed sending these. A1+ refactor must keep
    // reading every one of them.
    const REQUIRED_BODY_FIELDS = [
      'lang',
      'voice_style',
      'response_modalities',
      'conversation_summary',
      'transcript_history',
      'reconnect_stage',
      'conversation_id',
    ];

    it.each(REQUIRED_BODY_FIELDS)('handler reads "body.%s"', (field) => {
      // Tolerate spacing variation around the dot.
      const re = new RegExp(`body\\s*\\.\\s*${field}\\b`);
      expect(handlerBody).toMatch(re);
    });
  });

  describe('reconnect detection formula (VTID-02020)', () => {
    it('declares isReconnectStart based on transcript_history length OR reconnect_stage', () => {
      // The current contract is exactly:
      //   const isReconnectStart =
      //     reconnectTranscriptHistory.length > 0 || reconnectStage !== 'idle';
      // Any change to either operand or to the OR semantics must be flagged
      // by the refactor, because it changes which sessions get the contextual-
      // recovery prompt vs the standard greeting.
      expect(handlerBody).toMatch(/const\s+isReconnectStart\s*=/);
      expect(handlerBody).toMatch(/reconnectTranscriptHistory\.length\s*>\s*0/);
      expect(handlerBody).toMatch(/reconnectStage\s*!==?\s*['"`]idle['"`]/);
    });

    it('valid reconnect_stage values are exactly {idle, listening_user_speaking, thinking, speaking}', () => {
      // The handler validates body.reconnect_stage against this exact whitelist.
      // Adding a value silently could change observable behavior; removing one
      // would make formerly-valid clients fail open to 'idle'. Lock the set.
      for (const value of ['idle', 'listening_user_speaking', 'thinking', 'speaking']) {
        const re = new RegExp(`reconnect_stage\\s*===?\\s*['"\`]${value}['"\`]`);
        expect(handlerBody).toMatch(re);
      }
    });

    it('truncates transcript_history to the last 20 turns', () => {
      // The 20-turn cap is a real contract — too high blows the prompt budget,
      // too low drops mid-conversation context. A8 must preserve it.
      expect(handlerBody).toMatch(/\.slice\s*\(\s*-\s*20\s*\)/);
    });

    it('rejects malformed transcript history entries (role + text type guard)', () => {
      // The handler filters entries to only {role: 'user' | 'assistant', text: string}.
      // Lock the type guard so a refactor doesn't accidentally widen it.
      expect(handlerBody).toMatch(/role\s*===?\s*['"`]user['"`]/);
      expect(handlerBody).toMatch(/role\s*===?\s*['"`]assistant['"`]/);
      expect(handlerBody).toMatch(/typeof\s+\w+\.text\s*===?\s*['"`]string['"`]/);
    });
  });

  describe('origin + auth gates (pre-conditions before any session is created)', () => {
    it('validates origin before doing any work', () => {
      // The first observable gate is validateOrigin(req). If any work happens
      // before it (e.g. a side-effecting log of session metadata), an
      // attacker can probe the gateway via the orb endpoint.
      const validateIdx = handlerBody.indexOf('validateOrigin');
      expect(validateIdx).toBeGreaterThan(0);

      const bodyParseIdx = handlerBody.indexOf('req.body as LiveSessionStartRequest');
      expect(bodyParseIdx).toBeGreaterThan(0);

      // validateOrigin must precede the typed body parse — locks the order.
      expect(validateIdx).toBeLessThan(bodyParseIdx);
    });

    it('rejects bearer tokens that failed JWT verification with 401 (VTID-AUTH-BACKEND-REJECT)', () => {
      // Stale authenticated sessions used to silently degrade into anonymous
      // greetings. The 401 path stops that. A8 must keep it.
      expect(handlerBody).toMatch(/401/);
      expect(handlerBody).toMatch(/AUTH_TOKEN_INVALID/);
    });
  });
});
