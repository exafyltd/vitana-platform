/**
 * VTID-03683: Amazon Transcribe streaming STT for the cascaded voice pipeline.
 *
 * This is the "speech → text" leg. It exists because Nova Sonic does not
 * support `ru`/`pl`/`ar`/`zh` at all (see `cascaded-config.ts`), so those
 * languages need the three-hop cascade instead of speech-to-speech.
 *
 * AUDIO FORMAT — NO RESAMPLING, DELIBERATELY
 * ------------------------------------------
 * The ORB widget already sends 16 kHz / 16-bit / mono PCM, because that is
 * what Nova's `audioInputConfiguration` requires
 * (`NOVA_INPUT_SAMPLE_RATE_HZ = 16_000`, `sampleSizeBits: 16`,
 * `channelCount: 1`). Transcribe streaming accepts exactly that shape
 * (`MediaEncoding: 'pcm'`), so this leg is a pass-through. Resampling here
 * would be pure loss with no benefit — and a sample-rate mismatch is the
 * classic silent STT failure: Transcribe returns confident, fluent, wrong
 * transcripts rather than an error, the same failure family as the VTID-03495
 * "Polly PCM is 16 kHz, not 24 kHz" note.
 */

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
  type LanguageCode,
} from '@aws-sdk/client-transcribe-streaming';
import { resolveTranscribeRegion } from '../cascaded-config';

/** A finalized or in-progress transcript fragment from Transcribe. */
export interface TranscriptFragment {
  text: string;
  /** Transcribe marks a result `IsPartial` until it stabilises. */
  isPartial: boolean;
}

/**
 * A minimal async queue that adapts "push audio whenever it arrives" (how the
 * WebSocket delivers it) to "pull the next chunk" (what the SDK's async
 * iterable demands).
 *
 * Written out rather than pulled from a library because the back-pressure
 * semantics matter and are only three cases: a waiting consumer gets the
 * value directly, otherwise it buffers, and `close()` releases a consumer
 * that is parked on an empty queue. Getting that last case wrong hangs the
 * stream open forever on a session that has already ended — which on a
 * per-second-billed API is the expensive kind of bug.
 */
class AudioQueue {
  private readonly buffer: Uint8Array[] = [];
  private resolveNext: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: chunk, done: false });
      return;
    }
    this.buffer.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
    return new Promise((resolve) => {
      this.resolveNext = resolve;
    });
  }
}

export interface TranscribeStreamOptions {
  /** Transcribe `LanguageCode`, e.g. `ru-RU` (from `cascaded-config.ts`). */
  languageCode: LanguageCode;
  sampleRateHz?: number;
  region?: string;
}

/**
 * One Transcribe streaming session, living as long as the ORB session does.
 *
 * The stream is opened lazily on the FIRST audio chunk rather than at
 * construction. Transcribe bills per second of open stream, and an ORB
 * session that connects but never speaks is common (the VTID-03510 idle
 * analysis measured 97.5% of the old Gemini bill as exactly that) — opening
 * eagerly would bill every one of those.
 */
export class TranscribeStreamSession {
  private readonly client: TranscribeStreamingClient;
  private readonly queue = new AudioQueue();
  private readonly languageCode: LanguageCode;
  private readonly sampleRateHz: number;

  private started = false;
  private stopped = false;
  private pump: Promise<void> | null = null;

  private fragmentHandler: ((f: TranscriptFragment) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  constructor(opts: TranscribeStreamOptions) {
    this.languageCode = opts.languageCode;
    this.sampleRateHz = opts.sampleRateHz ?? 16_000;
    this.client = new TranscribeStreamingClient({
      region: opts.region ?? resolveTranscribeRegion(),
    });
  }

  onFragment(handler: (f: TranscriptFragment) => void): void {
    this.fragmentHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Feed one base64 PCM chunk. Opens the upstream stream on first call. */
  pushAudioB64(audioB64: string): void {
    if (this.stopped) return;
    let chunk: Buffer;
    try {
      chunk = Buffer.from(audioB64, 'base64');
    } catch {
      return;
    }
    if (chunk.length === 0) return;
    if (!this.started) this.start();
    this.queue.push(new Uint8Array(chunk));
  }

  private start(): void {
    if (this.started) return;
    this.started = true;

    const queue = this.queue;
    const audioStream: AsyncIterable<AudioStream> = {
      [Symbol.asyncIterator](): AsyncIterator<AudioStream> {
        return {
          async next(): Promise<IteratorResult<AudioStream>> {
            const r = await queue.next();
            if (r.done) return { value: undefined as unknown as AudioStream, done: true };
            return { value: { AudioEvent: { AudioChunk: r.value } }, done: false };
          },
        };
      },
    };

    this.pump = (async () => {
      try {
        const response = await this.client.send(
          new StartStreamTranscriptionCommand({
            LanguageCode: this.languageCode,
            MediaEncoding: 'pcm',
            MediaSampleRateHertz: this.sampleRateHz,
            AudioStream: audioStream,
          }),
        );
        if (!response.TranscriptResultStream) return;
        for await (const event of response.TranscriptResultStream) {
          if (this.stopped) break;
          const results = event.TranscriptEvent?.Transcript?.Results;
          if (!results?.length) continue;
          for (const result of results) {
            const text = result.Alternatives?.[0]?.Transcript ?? '';
            if (!text) continue;
            this.fragmentHandler?.({ text, isPartial: result.IsPartial === true });
          }
        }
      } catch (err) {
        // A stop() that tears the stream down mid-await surfaces here as a
        // rejection. That is an expected teardown, not a fault, and reporting
        // it would put a spurious error on every clean session close.
        if (this.stopped) return;
        this.errorHandler?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  /** Whether any audio has actually been sent (i.e. the stream is billing). */
  isStreaming(): boolean {
    return this.started && !this.stopped;
  }

  /** Close the stream. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close();
    try {
      await this.pump;
    } catch {
      /* teardown races are not interesting */
    }
    try {
      this.client.destroy();
    } catch {
      /* destroy is best-effort */
    }
  }
}
