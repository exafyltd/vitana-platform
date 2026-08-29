/**
 * VTID-03797 — a guided-topic session must NOT be handed a verbatim-
 * reproduction directive in its SYSTEM INSTRUCTION.
 *
 * Why this suite exists, measured rather than assumed (staging, 2026-08-29):
 * with the turn-1 trigger already made compositional, guided sessions on Nova
 * were still blocked 6/6 with `nova_validation` ("blocked by our content
 * filters"), while the ordinary control succeeded on a LARGER instruction
 * (31,186 vs 30,178 chars) and the same topics worked on the cascade upstream.
 * The German session was rejected BEFORE `greeting_sent` fired, so the payload
 * being rejected is the SETUP — this block — not the trigger.
 *
 * The guarded invariant is therefore: on a guided topic, this block states the
 * INTENT and quotes no sentence; on every other session it is byte-for-byte
 * what it was before, because non-guided override_v2 sessions carry the same
 * block and succeed ~50% of the time.
 */
import { buildVertexWakeBriefBlock } from '../../../../src/orb/live/session/live-session-controller';

const LINE = 'So, das war Was ist Vitanaland. Hast du Fragen dazu, oder sollen wir direkt gemeinsam loslegen?';

describe('VTID-03797 guided-topic SPOKEN FIRST UTTERANCE block', () => {
  describe('guided topic (the blocked path)', () => {
    const block = buildVertexWakeBriefBlock(LINE, 'de', 'guided_topic:T001');

    it('does NOT command verbatim reproduction', () => {
      expect(block).not.toMatch(/REQUIRED VERBATIM/i);
      expect(block).not.toMatch(/MUST\s+be\s+EXACTLY this text/i);
      expect(block).not.toMatch(/letter-for-letter/i);
      expect(block).not.toMatch(/do not paraphrase/i);
      expect(block).not.toMatch(/do not translate/i);
    });

    it('does NOT embed the provider line as a quoted sentence', () => {
      expect(block).not.toContain(LINE);
      expect(block).not.toContain(`"${LINE}"`);
    });

    it('tells the model to compose the opener itself', () => {
      expect(block).toMatch(/Compose\s+that sentence yourself/i);
      expect(block).toMatch(/ONE short, warm sentence/i);
    });

    it('still suppresses the SHORT-GAP GREETING PHRASES pool', () => {
      // The marker is what buildLiveSystemInstruction detects to skip the pool;
      // losing it reintroduces the VTID-03079/03097 regression.
      expect(block).toContain('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>');
      expect(block).toMatch(/SHORT-GAP GREETING PHRASES/);
      expect(block).toMatch(/SUPPRESSED for this turn/);
    });

    it('still carries the dedupe key and the no-relesson rule', () => {
      expect(block).toContain('Dedupe key: guided_topic:T001');
      expect(block).toMatch(/Do NOT re-deliver or summarise the lesson/i);
    });
  });

  describe('non-guided sessions are untouched (the ~50%-working path)', () => {
    const block = buildVertexWakeBriefBlock(LINE, 'de', 'newday_overview:2026-08-29');

    it('keeps the verbatim directive exactly as before', () => {
      expect(block).toMatch(/## SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM \(VTID-03079 \/ VTID-03097\)/);
      expect(block).toMatch(/MUST\s*\n?be EXACTLY this text/);
      expect(block).toMatch(/letter-for-letter/);
      expect(block).toContain(`"${LINE}"`);
    });

    it('applies to a null dedupe key too', () => {
      const noKey = buildVertexWakeBriefBlock(LINE, 'de', null);
      expect(noKey).toMatch(/REQUIRED VERBATIM/);
      expect(noKey).toContain(`"${LINE}"`);
      expect(noKey).not.toContain('Dedupe key:');
    });

    it('does not accidentally match a key that merely contains the prefix', () => {
      // startsWith, not includes — a key like `x:guided_topic:T001` is not ours.
      const notGuided = buildVertexWakeBriefBlock(LINE, 'de', 'reminder:guided_topic:T001');
      expect(notGuided).toMatch(/REQUIRED VERBATIM/);
    });
  });

  it('the structured-block bypass still wins over both branches', () => {
    // VTID-03167: a provider that already built a complete block is used as-is,
    // and that must remain true even for a guided topic.
    const structured = '__VTID_03167_STRUCTURED_BLOCK__\n## MY OWN BLOCK\nhello';
    const out = buildVertexWakeBriefBlock(structured, 'de', 'guided_topic:T001');
    expect(out).toBe('## MY OWN BLOCK\nhello');
  });
});
