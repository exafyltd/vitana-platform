/**
 * VTID-03762 — guided-topic "teaching complete" signal.
 *
 * Live-reported regression, downstream of VTID-03685: guided-topic teaching
 * now genuinely happens (VTID-03746/03685-era fixes confirmed working), but
 * nothing ever tells the model or the app "teaching is done" — the GUIDE
 * MODE system-instruction block (guided-topic-narration-prompt.ts) has no
 * turn-count limit and no other exit condition, so the model free-wheels
 * into ordinary conversation forever once it has covered the material. The
 * "Well done" drawer in vitana-v1's GuidedJourneyCatalog.tsx is opened at
 * TAP time (mounted underneath the ORB's full-screen overlay the whole
 * session) — it only becomes visible once that overlay closes, and nothing
 * closed it any more since VTID-03685 removed the old (too-early) auto-close.
 *
 * Fix: add a model-callable tool, `end_guided_topic_teaching`, mirroring the
 * already-proven Teacher Mode pattern (`end_teaching_session` /
 * `teacher_event` in the same file) — the model calls it once it has
 * actually taught the topic and answered follow-ups; the server relays an
 * `orb_directive`; the widget closes the overlay the same way
 * `end_teaching_session` already does, revealing the drawer underneath.
 *
 * No new DB write is introduced here — topic completion (the checkmark)
 * still flows through the EXISTING practice-drawer buttons
 * (openPracticeFeature / markPracticeDone in GuidedJourneyCatalog.tsx,
 * unchanged), now simply reachable again because the overlay actually
 * closes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildLiveApiTools } from '../../../src/routes/orb-live';

describe('VTID-03762: end_guided_topic_teaching tool declaration', () => {
  it('is present in the authenticated tool catalog, right after end_teaching_session', () => {
    const tools = buildLiveApiTools('authenticated', '/health', 'community') as Array<{
      function_declarations?: Array<{ name: string; description?: string; parameters?: unknown }>;
    }>;
    const decls = tools.flatMap((g) => g.function_declarations ?? []);
    const names = decls.map((d) => d.name);
    expect(names).toContain('end_guided_topic_teaching');
    expect(names).toContain('end_teaching_session');
    // Ordering isn't load-bearing for the model, but pins the declared
    // adjacency this test's own header describes — a drifted position
    // would still be correct behavior, just worth noticing.
    expect(names.indexOf('end_guided_topic_teaching')).toBe(names.indexOf('end_teaching_session') + 1);
  });

  it('is NOT present for an anonymous session (matches every other authenticated-only tool)', () => {
    const tools = buildLiveApiTools('anonymous', '/health', undefined) as Array<{
      function_declarations?: Array<{ name: string }>;
    }>;
    const names = tools.flatMap((g) => g.function_declarations ?? []).map((d) => d.name);
    expect(names).not.toContain('end_guided_topic_teaching');
  });

  it('takes an optional freeform "reason" parameter, same shape as end_teaching_session', () => {
    const tools = buildLiveApiTools('authenticated', '/health', 'community') as Array<{
      function_declarations?: Array<{ name: string; parameters?: { type: string; properties: Record<string, unknown>; required: string[] } }>;
    }>;
    const decl = tools.flatMap((g) => g.function_declarations ?? []).find((d) => d.name === 'end_guided_topic_teaching');
    expect(decl).toBeDefined();
    expect(decl!.parameters?.type).toBe('object');
    expect(decl!.parameters?.properties).toHaveProperty('reason');
    expect(decl!.parameters?.required).toEqual([]);
  });

  it('description tells the model to call it AFTER teaching, not before', () => {
    const tools = buildLiveApiTools('authenticated', '/health', 'community') as Array<{
      function_declarations?: Array<{ name: string; description?: string }>;
    }>;
    const decl = tools.flatMap((g) => g.function_declarations ?? []).find((d) => d.name === 'end_guided_topic_teaching');
    expect(decl!.description).toMatch(/ALWAYS call this AFTER/);
    expect(decl!.description).toMatch(/Do not call this\s*\n?\s*before you have actually explained/);
  });
});

describe('VTID-03762: orb-live.ts dispatcher handles end_guided_topic_teaching', () => {
  const ORB_LIVE_PATH = path.resolve(__dirname, '../../../src/routes/orb-live.ts');
  const source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

  function extractCaseBody(src: string, caseLabel: string): string {
    const idx = src.indexOf(`case '${caseLabel}': {`);
    expect(idx).toBeGreaterThan(-1);
    const openIdx = src.indexOf('{', idx);
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
    throw new Error(`unclosed case body: ${caseLabel}`);
  }

  it('has a case body for end_guided_topic_teaching', () => {
    expect(source).toContain(`case 'end_guided_topic_teaching': {`);
  });

  it("emits an orb_directive with directive:'end_guided_topic_teaching' over both SSE and WS", () => {
    const body = extractCaseBody(source, 'end_guided_topic_teaching');
    expect(body).toMatch(/directive:\s*'end_guided_topic_teaching'/);
    expect(body).toContain('session.sseResponse');
    expect(body).toContain('session.clientWs');
  });

  it('includes the active guided_topic_id in the directive payload (for the client + telemetry)', () => {
    const body = extractCaseBody(source, 'end_guided_topic_teaching');
    expect(body).toMatch(/session\.guided_topic_id/);
    expect(body).toMatch(/topic_id:\s*topicId/);
  });

  it('never throws on a transport write failure — the directive emit is wrapped in try/catch', () => {
    const body = extractCaseBody(source, 'end_guided_topic_teaching');
    const tryIdx = body.indexOf('try {');
    const catchIdx = body.indexOf('} catch');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
  });

  it('always returns success:true (best-effort, matching end_teaching_session)', () => {
    const body = extractCaseBody(source, 'end_guided_topic_teaching');
    expect(body).toMatch(/success:\s*true/);
  });
});

describe('VTID-03762: orb-widget.js closes the overlay on the end_guided_topic_teaching directive', () => {
  const WIDGET_PATH = path.resolve(
    __dirname,
    '../../../src/frontend/command-hub/orb-widget.js',
  );
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it("handles msg.directive === 'end_guided_topic_teaching'", () => {
    expect(source).toContain("msg.directive === 'end_guided_topic_teaching'");
  });

  // Codex review on this PR flagged the original fixed-500ms wait (a
  // byte-for-byte copy of end_teaching_session's own teardown): it could
  // truncate the model's closing line whenever more than ~500ms of audio
  // was still scheduled/queued, and audioPlaying=false doesn't stop new
  // chunks from being queued either. Fixed by reusing the polling pattern
  // the `navigate` directive already uses elsewhere in this same file.
  it('polls audioPlaying/scheduledSources/audioQueue before hiding, same pattern as the navigate directive', () => {
    const idx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const nextElseIdx = source.indexOf('} else {', idx);
    const block = source.slice(idx, nextElseIdx);
    expect(block).toMatch(/stillPlaying\s*=\s*_s\.audioPlaying\s*\|\|/);
    expect(block).toContain('_s.scheduledSources && _s.scheduledSources.length > 0');
    expect(block).toContain('_s.audioQueue && _s.audioQueue.length > 0');
  });

  it('has a hard safety cap so a stuck/misreported audio state cannot wait forever', () => {
    const idx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const nextElseIdx = source.indexOf('} else {', idx);
    const block = source.slice(idx, nextElseIdx);
    expect(block).toMatch(/_guidedEndAttempts\+\+\s*<\s*100/);
  });

  it('calls _hide() only after the poll resolves (audio drained or cap hit), not on a blind fixed delay', () => {
    const idx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const nextElseIdx = source.indexOf('} else {', idx);
    const block = source.slice(idx, nextElseIdx);
    // No longer a bare "setTimeout(..., 500)" straight to _hide() — must be
    // gated behind the stillPlaying poll first.
    expect(block).not.toMatch(/_hide\(\);[\s\S]{0,40}\},\s*500\)/);
    const stillPlayingIdx = block.indexOf('stillPlaying');
    const hideIdx = block.indexOf('_hide();');
    expect(stillPlayingIdx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(stillPlayingIdx);
  });

  it('does NOT set audioPlaying=false as a way to stop new chunks — that flag does not gate the audio handler', () => {
    const idx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const nextElseIdx = source.indexOf('} else {', idx);
    const block = source.slice(idx, nextElseIdx);
    expect(block).not.toMatch(/_s\.audioPlaying = false;/);
  });

  it('fires an optional onGuidedTopicTeachingEnd host callback, without throwing if absent', () => {
    const idx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const nextElseIdx = source.indexOf('} else {', idx);
    const block = source.slice(idx, nextElseIdx);
    expect(block).toMatch(/typeof _cfg\.onGuidedTopicTeachingEnd === 'function'/);
  });

  it('does not disturb the existing end_teaching_session branch (Teacher Mode unaffected)', () => {
    expect(source).toContain("msg.directive === 'end_teaching_session'");
    // Both branches must still funnel into the same final "unknown directive" else.
    const endTeachingIdx = source.indexOf("msg.directive === 'end_teaching_session'");
    const guidedTopicIdx = source.indexOf("msg.directive === 'end_guided_topic_teaching'");
    const unknownElseIdx = source.indexOf("console.warn('[VTOrb] Unknown orb_directive:");
    expect(endTeachingIdx).toBeLessThan(guidedTopicIdx);
    expect(guidedTopicIdx).toBeLessThan(unknownElseIdx);
  });
});
