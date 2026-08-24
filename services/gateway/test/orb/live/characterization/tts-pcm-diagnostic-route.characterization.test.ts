/**
 * VTID-03716 — a stateless, automated way to prove cascade-voice PCM audio
 * plays back at the correct speed, without opening a live ORB session or
 * relying on a human to listen.
 *
 * `/tts-pcm-diagnostic` calls the exact same `synthesizePolly({format:'pcm'})`
 * path `CascadedLiveClient.runTurn()` uses for live cascade-voice sessions
 * (VTID-03683/VTID-03711), but as a stateless (text, lang) -> audio call —
 * no session, no memory extraction, no account write of any kind. See
 * `scripts/tts/verify-cascade-audio-timing.ts` for the program that calls
 * this route end-to-end and mathematically proves the VTID-03711 fix
 * against real Polly bytes.
 *
 * This file is a source characterization test, matching this codebase's
 * established pattern for orb-live.ts (too large/stateful to boot the whole
 * WebSocket harness for a unit test — see
 * zero-turn-greeting-recovery-not-silenced.characterization.test.ts for the
 * same shape).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

function extractRouteBody(): string {
  const start = orbLive.indexOf("router.post('/tts-pcm-diagnostic'");
  expect(start).toBeGreaterThan(-1);
  // Bounded slice up to the next top-level route/comment block start, matching
  // the sibling /tts route's own extraction style.
  const end = orbLive.indexOf("VTID-FALLBACK: POST /live/chat-tts", start);
  expect(end).toBeGreaterThan(start);
  return orbLive.slice(start, end);
}

describe('VTID-03716 — /tts-pcm-diagnostic route', () => {
  const routeBody = extractRouteBody();

  it('is mounted with optionalAuth — stateless, no session required', () => {
    expect(routeBody).toMatch(/router\.post\('\/tts-pcm-diagnostic',\s*optionalAuth/);
  });

  it('calls synthesizePolly with format:"pcm" unconditionally — the same call CascadedLiveClient makes', () => {
    expect(routeBody).toMatch(/synthesizePolly\(\{\s*text,\s*lang,\s*format:\s*'pcm'\s*\}\)/);
  });

  it('does not gate on TTS_PROVIDER — imports synthesizePolly directly, not the tts-provider wrapper', () => {
    // The route body itself must call the direct import, not tryPollySynthesis
    // (which no-ops unless TTS_PROVIDER=polly) — this diagnostic must work
    // regardless of the ambient provider config, same as guided-topic-narration-audio.ts.
    expect(routeBody).not.toMatch(/tryPollySynthesis/);
  });

  it('returns sample_rate_hz and a matching audio/pcm;rate= mime — the exact fields the widget fix reads', () => {
    expect(routeBody).toMatch(/sample_rate_hz:\s*result\.sampleRateHz/);
    expect(routeBody).toMatch(/mime:\s*`audio\/pcm;rate=\$\{result\.sampleRateHz\}`/);
  });

  it('rejects empty text with 400, not a silent empty-audio synthesis attempt', () => {
    expect(routeBody).toMatch(/if\s*\(!text\)\s*\{\s*\n\s*return res\.status\(400\)/);
  });

  it('rejects oversized text with 400 before calling Polly (cost/latency guard)', () => {
    expect(routeBody).toMatch(/text\.length > 3000/);
  });

  it('reports a Polly-unsupported language distinctly (422), not a generic 500', () => {
    expect(routeBody).toMatch(/POLLY_UNSUPPORTED_LANGS\.has\(lang\)/);
    expect(routeBody).toMatch(/res\.status\(422\)/);
  });

  it('the import is the direct, unconditional Polly module, not the gated provider wrapper', () => {
    expect(orbLive).toMatch(
      /import \{ synthesizePolly, POLLY_UNSUPPORTED_LANGS \} from '\.\.\/services\/tts\/polly';/,
    );
  });
});
