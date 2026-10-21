/**
 * One-shot dev script — render the 14 ORB disconnect/recovery alert clips
 * as MP3 files in a modern neural voice, then commit them to the repo so
 * the orb-widget can play them at alert time without any runtime TTS
 * dependency (critical: must work when the user's network is dead).
 *
 * Run:
 *   cd services/gateway
 *   npx tsx scripts/render-orb-alert-clips.ts             # use deployed gateway (Neural2)
 *   npx tsx scripts/render-orb-alert-clips.ts --local     # use local ADC (Chirp3-HD)
 *
 * Re-run only when the phrase text below changes. The output MP3s are
 * committed to services/gateway/src/frontend/command-hub/sounds/orb-alert/.
 *
 * Voice choice rationale: the Vertex Live API voices (Aoede, Kore) cannot
 * be synthesized for arbitrary phrases outside an active Live session.
 *   - Default mode hits the deployed gateway's /api/v1/orb/tts endpoint,
 *     which renders Neural2 voices (en-US-Neural2-H, de-DE-Neural2-G) —
 *     the same modern neural voices used by the production /chat-tts
 *     fallback. No local Google Cloud auth required.
 *   - --local mode uses Google Cloud TextToSpeechClient directly with
 *     Chirp3-HD voices (en-US-Chirp3-HD-Leda, de-DE-Chirp3-HD-Achernar).
 *     Slightly higher fidelity. Requires fresh ADC:
 *       gcloud auth application-default login
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Clip {
  id: string;
  lang: 'en' | 'de';
  text: string;
}

const CLIPS: Clip[] = [
  // Disconnect alerts
  { id: 'disconnect-mic-en',        lang: 'en', text: "One moment, I can't hear your microphone." },
  { id: 'disconnect-mic-de',        lang: 'de', text: 'Einen Moment, Mikrofon-Problem.' },
  { id: 'disconnect-network-en',    lang: 'en', text: 'One moment, we have internet issues.' },
  { id: 'disconnect-network-de',    lang: 'de', text: 'Einen Moment, Internet-Problem.' },
  { id: 'disconnect-connection-en', lang: 'en', text: "Hold on, I'm reconnecting. Please wait." },
  { id: 'disconnect-connection-de', lang: 'de', text: 'Einen Moment, ich verbinde mich neu.' },
  { id: 'disconnect-offline-en',    lang: 'en', text: "You're offline. Please wait, don't talk yet." },
  { id: 'disconnect-offline-de',    lang: 'de', text: 'Du bist offline. Bitte warte mit Sprechen.' },

  // Recovery
  { id: 'recovery-network-en',    lang: 'en', text: "Okay, we're back online. I'm listening." },
  { id: 'recovery-network-de',    lang: 'de', text: 'Okay, das Netz ist wieder da. Ich höre zu.' },
  { id: 'recovery-mic-en',        lang: 'en', text: "Okay, the microphone is working again. Let's continue." },
  { id: 'recovery-mic-de',        lang: 'de', text: 'Okay, das Mikrofon funktioniert wieder. Wir können weitermachen.' },
  { id: 'recovery-connection-en', lang: 'en', text: "Okay, sorry for the interruption. I'm listening." },
  { id: 'recovery-connection-de', lang: 'de', text: 'Okay, entschuldige die Unterbrechung. Ich höre zu.' },
];

const OUT_DIR = path.resolve(__dirname, '..', 'src', 'frontend', 'command-hub', 'sounds', 'orb-alert');
const DEPLOYED_GATEWAY = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';

const useLocal = process.argv.includes('--local');

async function renderViaGateway(clip: Clip): Promise<Buffer> {
  const resp = await fetch(`${DEPLOYED_GATEWAY}/api/v1/orb/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clip.text, lang: clip.lang }),
  });
  if (!resp.ok) throw new Error(`Gateway ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { ok: boolean; audio_b64?: string; error?: string };
  if (!data.ok || !data.audio_b64) throw new Error(data.error || 'Gateway returned no audio');
  return Buffer.from(data.audio_b64, 'base64');
}

async function renderViaLocalAdc(clip: Clip): Promise<Buffer> {
  const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
  const client = new TextToSpeechClient();
  const VOICES: Record<'en' | 'de', { name: string; languageCode: string }> = {
    en: { name: 'en-US-Chirp3-HD-Leda', languageCode: 'en-US' },
    de: { name: 'de-DE-Chirp3-HD-Achernar', languageCode: 'de-DE' },
  };
  const voice = VOICES[clip.lang];
  const [response] = await client.synthesizeSpeech({
    input: { text: clip.text },
    voice: { languageCode: voice.languageCode, name: voice.name },
    audioConfig: { audioEncoding: 'MP3' as any, speakingRate: 1.0, pitch: 0 },
  });
  if (!response.audioContent) throw new Error('No audio content');
  return Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent as Uint8Array);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[render-orb-alert-clips] Output dir: ${OUT_DIR}`);
  console.log(`[render-orb-alert-clips] Mode: ${useLocal ? 'local ADC (Chirp3-HD)' : `deployed gateway (Neural2) — ${DEPLOYED_GATEWAY}`}`);
  console.log('');

  for (const clip of CLIPS) {
    const outPath = path.join(OUT_DIR, `${clip.id}.mp3`);
    process.stdout.write(`  ${clip.id.padEnd(28)} ... `);

    try {
      const buf = useLocal ? await renderViaLocalAdc(clip) : await renderViaGateway(clip);
      fs.writeFileSync(outPath, buf);
      console.log(`${(buf.length / 1024).toFixed(1)} KB`);
    } catch (err: any) {
      console.log(`FAILED — ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n[render-orb-alert-clips] Done. Commit the MP3 files in:`);
  console.log(`  ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('[render-orb-alert-clips] FAILED:', err);
  process.exit(1);
});
