/**
 * Amazon Transcribe batch bridge — Aurora migration B7
 * (AURORA-B7-EDGE-FUNCTIONS-INVENTORY.md's "Remaining: transcribe-audio"
 * item). vitana-v1's `transcribe-audio` edge function sends a whole
 * recorded-clip audio blob (voice dictation, diary notes) to Gemini's
 * multimodal endpoint, with Google Cloud Speech-to-Text as a fallback — the
 * one frontend-reachable Gemini-dependent function `ai-bridge.ts`'s
 * text-only `/generate` leg cannot cover, since it has no audio input.
 *
 * Reuses this codebase's EXISTING Transcribe integration rather than
 * building a second one: `TRANSCRIBE_LANGUAGE_CODES` /
 * `resolveTranscribeLanguageCode()` / `resolveTranscribeRegion()`
 * (orb/live/upstream/cascaded-config.ts, VTID-03683) were already built and
 * verified for the ORB cascaded-voice pipeline — reusing them means this
 * bridge's language coverage can never silently drift from the cascade's,
 * the exact "five copies of the same table" failure this codebase's own
 * CHANGE LOG names repeatedly (VTID-03644).
 *
 * WHY BATCH, NOT THE STREAMING SESSION CLASS
 * -------------------------------------------
 * `cascaded/transcribe-stream.ts`'s `TranscribeStreamSession` is built for a
 * long-lived ORB session receiving audio incrementally over a WebSocket, with
 * fragment callbacks and idle-stream billing awareness. This call site has
 * the OPPOSITE shape: one complete audio blob, submitted once, needing one
 * final transcript back in the same HTTP request. Rather than force that
 * through session machinery it doesn't need, this feeds the WHOLE buffer
 * through the Transcribe streaming API as a short-lived, single-shot stream
 * (Transcribe has no separate "one-shot batch over HTTP" API for streaming
 * audio — `StartTranscriptionJob` requires an S3 round trip and is async,
 * minutes not seconds, wrong shape for "user taps stop, wants text back").
 *
 * WHY FFMPEG, NOT A DIRECT MEDIAENCODING PASS-THROUGH
 * -----------------------------------------------------
 * The browser's `MediaRecorder` output varies by platform (webm/opus on
 * Chrome/Firefox, mp4/aac on Safari/iOS) and Transcribe streaming only
 * accepts `pcm`, `ogg-opus`, or `flac` — none of which is a guaranteed match.
 * Rather than special-case each container (and silently mis-transcribe an
 * unhandled one, the "confident wrong transcript" failure this codebase's
 * own transcribe-stream.ts comment already warns about for sample-rate
 * mismatches), every input is decoded through `ffmpeg` — already on PATH via
 * the gateway Dockerfile's `apk add --no-cache ffmpeg` (used today by
 * video-thumbnail-service.ts) — to the one target every codec can decode
 * into: 16kHz mono 16-bit signed-little-endian raw PCM, the same encoding
 * Nova Sonic and the ORB cascade already use.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
} from '@aws-sdk/client-transcribe-streaming';
import { resolveTranscribeLanguageCode, resolveTranscribeRegion } from '../orb/live/upstream/cascaded-config';

export class TranscribeBridgeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'TranscribeBridgeError';
  }
}

const SAMPLE_RATE_HZ = 16_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const CHUNK_BYTES = 4096;

function runFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TranscribeBridgeError('FFMPEG_TIMEOUT', `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new TranscribeBridgeError('FFMPEG_SPAWN_FAILED', `ffmpeg failed to spawn: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Decodes an arbitrary-container audio buffer into raw 16kHz mono s16le PCM. */
async function decodeToPcm(audioBytes: Buffer, sourceExt: string): Promise<Buffer> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-bridge-'));
  const inputPath = path.join(workDir, `${randomUUID()}${sourceExt}`);
  const outputPath = path.join(workDir, `${randomUUID()}.pcm`);
  try {
    await fs.writeFile(inputPath, audioBytes);
    const { code, stderr } = await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-ar', String(SAMPLE_RATE_HZ),
      '-ac', '1',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      outputPath,
    ]);
    if (code !== 0) {
      throw new TranscribeBridgeError('FFMPEG_DECODE_FAILED', `ffmpeg exit ${code}: ${stderr.slice(0, 400)}`);
    }
    const pcm = await fs.readFile(outputPath);
    if (pcm.byteLength === 0) {
      throw new TranscribeBridgeError('EMPTY_PCM', 'ffmpeg produced no decodable audio');
    }
    return pcm;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Best-effort extension hint for ffmpeg's demuxer probe from a browser mime type. */
function extensionForMime(mimeType?: string): string {
  const mt = (mimeType || '').toLowerCase();
  if (mt.includes('webm')) return '.webm';
  if (mt.includes('ogg')) return '.ogg';
  if (mt.includes('wav')) return '.wav';
  if (mt.includes('flac')) return '.flac';
  if (mt.includes('aac')) return '.aac';
  if (mt.includes('mp3') || mt.includes('mpeg')) return '.mp3';
  if (mt.includes('mp4') || mt.includes('m4a')) return '.m4a';
  return '.bin'; // ffmpeg still demux-probes by content, not just extension
}

function pcmToChunkedAsyncIterable(pcm: Buffer): AsyncIterable<AudioStream> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AudioStream> {
      let offset = 0;
      return {
        async next(): Promise<IteratorResult<AudioStream>> {
          if (offset >= pcm.length) {
            return { value: undefined as unknown as AudioStream, done: true };
          }
          const end = Math.min(offset + CHUNK_BYTES, pcm.length);
          const chunk = new Uint8Array(pcm.subarray(offset, end));
          offset = end;
          return { value: { AudioEvent: { AudioChunk: chunk } }, done: false };
        },
      };
    },
  };
}

export interface TranscribeBridgeResult {
  transcript: string;
  languageCode: string;
}

/**
 * Transcribes one complete audio clip and returns the final transcript.
 * Throws TranscribeBridgeError on any failure — callers map that to an HTTP
 * error rather than silently returning an empty transcript, matching this
 * codebase's "always fail loudly" posture (CLAUDE.md ALWAYS 10).
 */
export async function transcribeAudioClip(
  audioBytes: Buffer,
  language: string,
  mimeType?: string,
): Promise<TranscribeBridgeResult> {
  const languageCode = resolveTranscribeLanguageCode(language);
  if (!languageCode) {
    throw new TranscribeBridgeError(
      'UNSUPPORTED_LANGUAGE',
      `Amazon Transcribe has no streaming language code for "${language}"`,
    );
  }

  const pcm = await decodeToPcm(audioBytes, extensionForMime(mimeType));

  const client = new TranscribeStreamingClient({ region: resolveTranscribeRegion() });
  try {
    const response = await client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: languageCode,
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: SAMPLE_RATE_HZ,
        AudioStream: pcmToChunkedAsyncIterable(pcm),
      }),
    );

    if (!response.TranscriptResultStream) {
      throw new TranscribeBridgeError('NO_RESULT_STREAM', 'Transcribe returned no TranscriptResultStream');
    }

    // A short clip settles into a small number of segments as Transcribe
    // finalizes them; only IsPartial===false results are stable — an
    // in-progress partial for a segment is superseded by its own later
    // final result, never appended alongside it.
    const finals: string[] = [];
    for await (const event of response.TranscriptResultStream) {
      const results = event.TranscriptEvent?.Transcript?.Results;
      if (!results?.length) continue;
      for (const result of results) {
        if (result.IsPartial === true) continue;
        const text = result.Alternatives?.[0]?.Transcript ?? '';
        if (text) finals.push(text);
      }
    }

    return { transcript: finals.join(' ').trim(), languageCode };
  } finally {
    try {
      client.destroy();
    } catch {
      /* destroy is best-effort */
    }
  }
}
