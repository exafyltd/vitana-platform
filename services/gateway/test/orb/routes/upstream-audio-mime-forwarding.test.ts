/**
 * VTID-03715 — the upstream's real PCM rate must survive the server.
 *
 * VTID-03711 taught `orb-widget.js` to read `chunk.mime` instead of hardcoding
 * 24000. That fixed the greeting bridge and guided-topic narration, which build
 * their mime from real data (`audio/pcm;rate=${sampleRateHz}`). It did NOT fix
 * ordinary cascaded conversation, because the rate never reached the client:
 *
 *   cascaded-live-client.ts  emits { dataB64, mimeType: 'audio/pcm;rate=16000' }
 *   upstream-message-handler  called onAudioResponse(event.dataB64)  <-- dropped
 *   orb-live.ts               forwarded mime: 'audio/pcm;rate=24000' <-- invented
 *
 * So Polly's 16kHz speech arrived labelled 24kHz and played 1.5x fast — the
 * reported chipmunk voice — and a client-side parser cannot recover from that,
 * because by then the lie is the only thing it has to read.
 *
 * Verified at source level, matching the sibling suites in this directory:
 * `orb-live.ts` is a very large WebSocket-stateful module whose integration
 * setup dwarfs the wire-up being asserted, and the wire-up IS the contract —
 * a rate quietly re-hardcoded here is exactly the regression this guards.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../../src');

const orbLive = fs.readFileSync(path.join(SRC, 'routes/orb-live.ts'), 'utf8');
const handler = fs.readFileSync(
  path.join(SRC, 'orb/live/session/upstream-message-handler.ts'),
  'utf8',
);
const cascade = fs.readFileSync(
  path.join(SRC, 'orb/live/upstream/cascaded-live-client.ts'),
  'utf8',
);

describe('VTID-03715: upstream audio mime survives forwarding', () => {
  describe('the cascade still declares its real rate', () => {
    it('labels every emitted chunk with the Polly PCM rate', () => {
      // The premise of the whole chain. If this stops being true, the bug is
      // upstream of everything below and these tests would pass while the
      // user still hears a chipmunk.
      expect(cascade).toMatch(
        /const mimeType = `audio\/pcm;rate=\$\{POLLY_PCM_SAMPLE_RATE_HZ\}`/,
      );
      expect(cascade).toMatch(/this\.audioHandler\?\.\(\{[^}]*mimeType[^}]*\}\)/);
    });
  });

  describe('the handler forwards it instead of dropping it', () => {
    it('passes event.mimeType through to onAudioResponse', () => {
      expect(handler).toMatch(
        /ctx\.callbacks\.onAudioResponse\(event\.dataB64,\s*event\.mimeType\)/,
      );
    });

    it('no longer calls onAudioResponse with the payload alone', () => {
      // The exact shape of the defect, asserted as absent.
      expect(handler).not.toMatch(/onAudioResponse\(event\.dataB64\)\s*;/);
    });

    it('declares the second parameter on both callback contracts', () => {
      // Two context interfaces carry this callback. Widening only one leaves
      // the other silently dropping the rate again.
      const decls = handler.match(
        /onAudioResponse:\s*\(audioB64: string,\s*mimeType\?: string\)\s*=>\s*void;/g,
      );
      expect(decls).toHaveLength(2);
    });
  });

  describe('orb-live.ts forwards the received rate, not a literal', () => {
    it('SSE and WS both send the chunk mime with a named fallback', () => {
      const forwards = orbLive.match(
        /mime: audioMime \|\| DEFAULT_UPSTREAM_AUDIO_MIME/g,
      );
      // SSE turn audio, WS turn audio, and the prebuffer flush.
      expect(forwards).toHaveLength(3);
    });

    it('both audio callbacks accept the mime parameter', () => {
      const sigs = orbLive.match(/\(audioB64: string, audioMime\?: string\) => \{/g);
      expect(sigs).toHaveLength(2);
    });

    it('names the fallback rather than scattering a bare literal', () => {
      expect(orbLive).toMatch(
        /const DEFAULT_UPSTREAM_AUDIO_MIME = 'audio\/pcm;rate=24000';/,
      );
    });
  });

  describe('the greeting prebuffer keeps each chunk with its own rate', () => {
    it('stores mime alongside the payload', () => {
      expect(orbLive).toMatch(
        /bufferedGreetingChunks \|\|= \[\]\)\.push\(\{ audioB64, audioMime \}\)/,
      );
    });

    it('types the buffer as pairs, not bare strings', () => {
      // `string[]` is what made the old code silently assume 24kHz. A cascaded
      // greeting held here is 16kHz, and would replay 1.5x fast.
      expect(orbLive).toMatch(
        /bufferedGreetingChunks\?: Array<\{ audioB64: string; audioMime\?: string \}>;/,
      );
      expect(orbLive).not.toMatch(/bufferedGreetingChunks\?: string\[\];/);
    });

    it('destructures both fields when replaying', () => {
      expect(orbLive).toMatch(
        /for \(const \{ audioB64: data_b64, audioMime \} of chunks\)/,
      );
    });
  });

  describe('the activation chime keeps its own literal, deliberately', () => {
    it('is synthesized at 24000 locally', () => {
      // Not an assumption about an upstream — a fact about bytes this file
      // generates itself. Rewriting these to the fallback constant would blur
      // "known" and "guessed", which is the distinction this VTID is about.
      expect(orbLive).toMatch(/function generateChimePcm\(\): string \{[\s\S]{0,120}const sampleRate = 24000;/);
    });

    it('every surviving hardcoded rate belongs to a chime send', () => {
      const lines = orbLive.split('\n');
      const offenders: number[] = [];
      lines.forEach((line, i) => {
        if (!line.includes("mime: 'audio/pcm;rate=24000'")) return;
        // The payload line sits just above the mime line in every send.
        const window = lines.slice(Math.max(0, i - 4), i).join('\n');
        if (!/chimePcm|generateChimePcm\(\)/.test(window)) offenders.push(i + 1);
      });
      expect(offenders).toEqual([]);
    });
  });
});
