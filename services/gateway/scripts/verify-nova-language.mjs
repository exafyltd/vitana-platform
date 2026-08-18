#!/usr/bin/env node
/**
 * VTID-03672 — prove a language is actually invokable on Nova 2 Sonic before
 * widening NOVA_SONIC_SUPPORTED_LANGUAGES to include it.
 *
 * WHY DOCUMENTATION IS NOT ENOUGH
 * -------------------------------
 * AWS docs describe what the MODEL supports. Whether THIS ACCOUNT may invoke it
 * is a separate fact, and the two have already diverged here once: under
 * VTID-03579 `ListInferenceProfiles` reported 22 Anthropic profiles as ACTIVE
 * and exactly 3 could be invoked, because entitlement is a Marketplace
 * subscription rather than an IAM or model property. The failure that produces
 * is not loud — the stage falls back and serves 100% of traffic from the
 * fallback provider while the config still reads as if it were switched over.
 *
 * A voice id is the same shape of risk: `carolina` is documented for pt-BR, but
 * a wrong or unavailable id fails at stream open, in production, for exactly
 * the users whose language was just switched.
 *
 * WHY THIS IS A SCRIPT AND NOT A CLI ONE-LINER
 * -------------------------------------------
 * Nova Sonic is `InvokeModelWithBidirectionalStream`, which requires HTTP/2 and
 * a full event handshake (sessionStart → promptStart → content blocks →
 * promptEnd → sessionEnd). `aws bedrock-runtime invoke-model` cannot express
 * it, so there is no shell equivalent to run instead.
 *
 * USAGE
 *   node scripts/verify-nova-language.mjs --lang pt --voice carolina
 *   node scripts/verify-nova-language.mjs --lang de --voice tina   # known-good control
 *
 * Exits 0 only when the model returned AUDIO for the requested voice.
 */
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { randomUUID } from 'node:crypto';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const MODEL_ID = arg('model', 'amazon.nova-2-sonic-v1:0');
const REGION = arg('region', 'eu-north-1');
const LANG = arg('lang', 'pt');
const VOICE = arg('voice', 'carolina');

// A sentence in the target language, so the reply is generated in it rather
// than merely spoken by a voice labelled with it.
const PROMPTS = {
  pt: 'Responda em português do Brasil, numa frase curta: o que é longevidade?',
  de: 'Antworte auf Deutsch in einem kurzen Satz: was ist Langlebigkeit?',
  en: 'Answer in English in one short sentence: what is longevity?',
  fr: 'Réponds en français en une phrase courte : qu’est-ce que la longévité ?',
  es: 'Responde en español en una frase corta: ¿qué es la longevidad?',
};

const promptName = randomUUID();
const sysContent = randomUUID();
const usrContent = randomUUID();
const audContent = randomUUID();
// REAL speech, not silence. Nova Sonic is speech-to-speech: silence produces a
// valid stream that simply never generates a turn, which is indistinguishable
// from "this language does not work" — the exact ambiguity this script exists
// to remove. Polly synthesises the prompt in the target language and its PCM is
// fed to Nova as the user's turn.
const POLLY_VOICE = { pt: 'Camila', de: 'Vicki', en: 'Joanna', fr: 'Lea', es: 'Lucia' };
const POLLY_LANG = { pt: 'pt-BR', de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES' };
async function synthesizePrompt(lang, text) {
  const polly = new PollyClient({ region: 'eu-central-1' });
  const out = await polly.send(new SynthesizeSpeechCommand({
    Text: text, OutputFormat: 'pcm', SampleRate: '16000',
    VoiceId: POLLY_VOICE[lang] ?? 'Joanna', LanguageCode: POLLY_LANG[lang] ?? 'en-US', Engine: 'neural',
  }));
  return Buffer.from(await out.AudioStream.transformToByteArray());
}
const SPEECH = await synthesizePrompt(LANG, PROMPTS[LANG] ?? PROMPTS.en);
console.log(`  polly pcm    : ${SPEECH.length} bytes (${POLLY_VOICE[LANG] ?? 'Joanna'})`);
// Nova wants a stream of chunks, not one blob.
const SPEECH_CHUNKS = [];
for (let i = 0; i < SPEECH.length; i += 3200) SPEECH_CHUNKS.push(SPEECH.subarray(i, i + 3200).toString('base64'));

const events = [
  { event: { sessionStart: { inferenceConfiguration: { maxTokens: 256, topP: 0.9, temperature: 0.7 } } } },
  {
    event: {
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: 24000,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId: VOICE,
          encoding: 'base64',
          audioType: 'SPEECH',
        },
      },
    },
  },
  { event: { contentStart: { promptName, contentName: sysContent, type: 'TEXT', role: 'SYSTEM', interactive: true, textInputConfiguration: { mediaType: 'text/plain' } } } },
  { event: { textInput: { promptName, contentName: sysContent, content: 'You are a concise assistant.' } } },
  { event: { contentEnd: { promptName, contentName: sysContent } } },
  // Nova REQUIRES at least one AUDIO content block per prompt — a text-only
  // prompt is rejected with "Prompt [...] must have at least one audio
  // content". Found by running a known-good control first, which failed on the
  // protocol rather than the language and would otherwise have read as "German
  // is not supported".
  //
  // The payload is silence: this script tests whether the ACCOUNT can invoke
  // the model with the given VOICE, not whether the model transcribes speech.
  { event: { contentStart: { promptName, contentName: audContent, type: 'AUDIO', role: 'USER', interactive: true,
      audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } } } },
  ...SPEECH_CHUNKS.map((c) => ({ event: { audioInput: { promptName, contentName: audContent, content: c } } })),
  { event: { contentEnd: { promptName, contentName: audContent } } },
  { event: { promptEnd: { promptName } } },
  { event: { sessionEnd: {} } },
];

const client = new BedrockRuntimeClient({
  region: REGION,
  requestHandler: new NodeHttp2Handler({ requestTimeout: 60_000, sessionTimeout: 90_000 }),
});

async function* body() {
  for (const e of events) {
    yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(e)) } };
  }
  // Hold the request stream open long enough for the model to answer — closing
  // it immediately after sessionEnd races the response and looks like a
  // premature close rather than a result.
  await new Promise((r) => setTimeout(r, 25_000));
}

console.log(`model=${MODEL_ID} region=${REGION} lang=${LANG} voice=${VOICE}`);

let audioChunks = 0;
let audioBytes = 0;
let text = '';
let failure = null;

try {
  const res = await client.send(
    new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: body() }),
  );
  for await (const evt of res.body) {
    const raw = evt.chunk?.bytes;
    if (!raw) {
      // A modelStreamErrorException / validationException surfaces as its own
      // member rather than a chunk — surface it verbatim, do not swallow it.
      const other = Object.keys(evt).filter((k) => k !== 'chunk');
      if (other.length) { failure = `${other.join(',')}: ${JSON.stringify(evt).slice(0, 300)}`; break; }
      continue;
    }
    const msg = JSON.parse(new TextDecoder().decode(raw));
    const ev = msg.event ?? {};
    if (ev.audioOutput?.content) {
      audioChunks++;
      audioBytes += Buffer.from(ev.audioOutput.content, 'base64').length;
    }
    if (ev.textOutput?.content) text += ev.textOutput.content;
    if (ev.completionEnd) break;
  }
} catch (e) {
  failure = `${e.name}: ${e.message}`;
}

console.log(`  audio chunks : ${audioChunks}`);
console.log(`  audio bytes  : ${audioBytes}`);
console.log(`  text         : ${text.trim().slice(0, 200) || '(none)'}`);
if (failure) console.log(`  FAILURE      : ${failure}`);

const ok = audioChunks > 0 && audioBytes > 0 && !failure;
console.log(ok ? `\nPASS — ${LANG}/${VOICE} is invokable on ${MODEL_ID}` : `\nFAIL — ${LANG}/${VOICE} did NOT produce audio`);
process.exit(ok ? 0 : 1);
