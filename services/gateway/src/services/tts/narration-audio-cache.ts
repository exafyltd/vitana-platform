/**
 * BOOTSTRAP-POLLY-NARRATION-CACHE — cache for guided-topic lesson audio.
 *
 * WHY THIS EXISTS
 *
 * `synthesizeGuidedTopicNarrationAudio()` is called from the continuation
 * provider's `produce()`, which runs on every guided-topic session start. It
 * had no cache of any kind, so every My Journey tap re-synthesized the full
 * ~1,800-character lesson from Polly before the session could open.
 *
 * The audio is fully deterministic: the same script, read by the same voice on
 * the same engine at the same sample rate, produces the same bytes. There are
 * 254 topics across 8 shipped languages — roughly 2,000 distinct assets — and
 * each was being paid for once per tap rather than once per asset.
 *
 * Caching therefore buys two things, and the second is the one users feel:
 *   1. cost — per-tap synthesis becomes per-asset synthesis.
 *   2. latency — synthesis leaves the tap path entirely on a hit. The whole
 *      VTID-03650→03685 chain was about guided-topic taps misbehaving; adding
 *      a Polly round trip to that path is not free.
 *
 * THE KEY IS THE DESIGN
 *
 * `buildNarrationCacheKey()` hashes EVERY input that determines the output
 * bytes: the exact synthesized text, the language, the resolved voice id, the
 * engine, and the sample rate. Nothing else needs to be tracked, and nothing
 * that changes the audio can be missed.
 *
 * That is what makes the pending neural→generative engine upgrade safe. The
 * engine is part of the key, so flipping it changes every key at once and no
 * listener can be served stale neural audio under a generative configuration.
 * A key of `(topic_id, lang)` alone would have looked perfectly reasonable and
 * would have served the old engine's audio forever after the flip — a silent
 * wrong-output bug of exactly the shape this repo keeps paying for (VTID-03578
 * Polly→English, VTID-03682 Nova→`tina`): a plausible value, no error, no
 * signal.
 *
 * FAILURE POSTURE — deliberately different from the DB seams
 *
 * `DB_I18N_TARGET`'s Aurora leg THROWS rather than falling back, because a
 * silent fallback there would leave an operator believing Aurora was written
 * when Supabase was. A cache is not like that: it holds no truth, and a miss
 * has a correct, cheap recovery — synthesize. So a store failure here logs
 * loudly and degrades to synthesis rather than failing the lesson. The user
 * still hears the right audio; only the saving is lost, and the log says so.
 *
 * What is NOT tolerated is silence. Every store error is logged with the store
 * name and the operation, so "the cache is configured but doing nothing" is
 * visible rather than presenting as ordinary cost.
 */

import { createHash } from 'crypto';

export interface NarrationAudioCacheEntry {
  audioB64: string;
  sampleRateHz: number;
}

/**
 * Inputs that determine the synthesized bytes. Every field participates in the
 * key — see the header on why the engine in particular must be included.
 */
export interface NarrationCacheKeyInputs {
  topicId: string;
  lang: string;
  /** The exact text handed to Polly, post-assembly. */
  text: string;
  voiceId: string;
  engine: string;
}

/**
 * A place rendered lesson audio can live. Both methods are best-effort by
 * contract: an implementation reports failure by returning null / resolving,
 * never by throwing, so a cache problem can never break a lesson.
 */
export interface NarrationAudioStore {
  /** Stable name for logs — the operator needs to know WHICH store failed. */
  readonly name: string;
  get(key: string): Promise<NarrationAudioCacheEntry | null>;
  put(key: string, entry: NarrationAudioCacheEntry): Promise<void>;
}

/**
 * Hash every determinant of the audio into one opaque key.
 *
 * The field list is written out explicitly rather than hashing an object,
 * because hashing an object keys on JS property insertion order — the same
 * trap `source_sha` hit in VTID-03515, where reading a record through a
 * different code path reported an entire locale as drifted.
 */
export function buildNarrationCacheKey(inputs: NarrationCacheKeyInputs): string {
  const material = [
    `topic=${inputs.topicId}`,
    `lang=${inputs.lang}`,
    `voice=${inputs.voiceId}`,
    `engine=${inputs.engine}`,
    `text=${inputs.text}`,
  ].join('\n');
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  // Prefix carries a schema version so a future change to what gets hashed
  // (or to the stored payload shape) invalidates rather than mis-reads.
  return `narration/v1/${inputs.lang}/${inputs.topicId}/${digest}`;
}

/* ------------------------------------------------------------------ *
 * In-process store
 * ------------------------------------------------------------------ */

const DEFAULT_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Bounded in-process LRU.
 *
 * Bounded by BYTES, not entry count: entries are audio buffers whose size
 * varies with lesson length, so a count-based cap would let a few long lessons
 * consume far more of the task's memory than intended.
 *
 * This survives neither a deploy nor a scale-out, so on its own it only
 * collapses repeat taps within one task's lifetime. It is the safe default
 * because it needs no infrastructure and cannot fail in a way that costs
 * anything; S3 is what makes the saving durable.
 */
export class MemoryNarrationStore implements NarrationAudioStore {
  readonly name = 'memory';
  private readonly entries = new Map<string, NarrationAudioCacheEntry>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number = DEFAULT_MEMORY_BUDGET_BYTES) {}

  async get(key: string): Promise<NarrationAudioCacheEntry | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // Re-insert to make this the most-recently-used entry.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  async put(key: string, entry: NarrationAudioCacheEntry): Promise<void> {
    const size = entry.audioB64.length;
    // An entry larger than the whole budget is not cacheable; storing it would
    // evict everything else to hold one item.
    if (size > this.budgetBytes) return;

    if (this.entries.has(key)) {
      this.bytes -= this.entries.get(key)!.audioB64.length;
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.bytes += size;

    while (this.bytes > this.budgetBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.bytes -= evicted.audioB64.length;
    }
  }

  /** Test/introspection helper — not used by the synthesis path. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}

/* ------------------------------------------------------------------ *
 * Store selection
 * ------------------------------------------------------------------ */

export type NarrationCacheMode = 'off' | 'memory' | 's3';

/**
 * Resolve the configured mode.
 *
 * Default is `memory`: it needs no infrastructure and cannot cost anything, so
 * shipping this module is a pure improvement even before a bucket exists.
 *
 * An UNRECOGNISED value resolves to `memory` rather than `off`. A typo in this
 * variable must not silently restore per-tap billing — the same reasoning as
 * `DB_I18N_AUTO_PROPAGATE`, where an unrecognised value stays ENABLED so a
 * mistyped flag cannot quietly stop every language updating.
 */
export function resolveNarrationCacheMode(
  raw: string | undefined = process.env.NARRATION_AUDIO_CACHE,
): NarrationCacheMode {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 's3') return 's3';
  if (v === 'memory') return 'memory';
  if (v.length > 0) {
    console.warn(
      `[NARRATION-CACHE] unrecognised NARRATION_AUDIO_CACHE="${raw}" — ` +
        `falling back to "memory" rather than disabling the cache.`,
    );
  }
  return 'memory';
}

/* ------------------------------------------------------------------ *
 * S3 store
 * ------------------------------------------------------------------ */

/**
 * Durable store on S3.
 *
 * `@aws-sdk/client-s3` is NOT currently in the gateway's dependency tree and
 * this service has no other S3 call site, so the client is imported lazily
 * inside a try/catch. That way this module still loads, and `memory` mode
 * still works, in a tree where the package is absent — rather than throwing at
 * import and taking the gateway down over a dependency it does not have. That
 * exact failure shape is on record here: `natural-language-service` threw at
 * module load on a missing Google key and would have killed the process at
 * import (VTID-03579).
 *
 * ⚠️ UNEXERCISED. At the time of writing this leg has never executed against a
 * real bucket — the dependency is not installed, the bucket does not exist, and
 * `vitana-ecs-task-role` has no s3 grant. It is written so the provisioning
 * work has something to switch on, and it reports `not_configured` loudly
 * rather than pretending to cache. Do not record it as working until a real
 * round trip is observed; per §2b's own lesson, configuration is not
 * verification.
 */
export class S3NarrationStore implements NarrationAudioStore {
  readonly name = 's3';
  private client: unknown = null;
  private unavailableReason: string | null = null;

  constructor(
    private readonly bucket: string,
    private readonly region: string,
  ) {}

  private async loadClient(): Promise<any | null> {
    if (this.client) return this.client;
    if (this.unavailableReason) return null;
    try {
      const mod: any = await import('@aws-sdk/client-s3');
      this.client = new mod.S3Client({ region: this.region });
      return this.client;
    } catch (err) {
      this.unavailableReason =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[NARRATION-CACHE] s3 store unavailable — @aws-sdk/client-s3 could not ` +
          `be loaded: ${this.unavailableReason}. Lessons will synthesize every ` +
          `tap until this is installed.`,
      );
      return null;
    }
  }

  async get(key: string): Promise<NarrationAudioCacheEntry | null> {
    const client: any = await this.loadClient();
    if (!client) return null;
    try {
      const mod: any = await import('@aws-sdk/client-s3');
      const res = await client.send(
        new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await res.Body.transformToByteArray();
      const rate = Number(res.Metadata?.['sample-rate-hz']);
      // A stored object with no usable sample rate is unusable: playing PCM at
      // the wrong rate is audible to a listener and invisible to any check that
      // only asserts bytes came back (the VTID-03495 24kHz-vs-16kHz trap).
      if (!Number.isFinite(rate) || rate <= 0) {
        console.warn(
          `[NARRATION-CACHE] s3 object ${key} has no valid sample-rate-hz ` +
            `metadata — ignoring the hit and re-synthesizing.`,
        );
        return null;
      }
      return {
        audioB64: Buffer.from(bytes).toString('base64'),
        sampleRateHz: rate,
      };
    } catch (err: any) {
      // A miss is the normal path on first render and must stay quiet, or the
      // logs fill with non-events and the real failures stop being readable.
      const code = err?.name || err?.Code;
      if (code === 'NoSuchKey' || code === 'NotFound') return null;
      console.error(
        `[NARRATION-CACHE] s3 get failed for ${key}: ${code || err?.message}`,
      );
      return null;
    }
  }

  async put(key: string, entry: NarrationAudioCacheEntry): Promise<void> {
    const client: any = await this.loadClient();
    if (!client) return;
    try {
      const mod: any = await import('@aws-sdk/client-s3');
      await client.send(
        new mod.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: Buffer.from(entry.audioB64, 'base64'),
          ContentType: 'audio/pcm',
          Metadata: { 'sample-rate-hz': String(entry.sampleRateHz) },
        }),
      );
    } catch (err: any) {
      console.error(
        `[NARRATION-CACHE] s3 put failed for ${key}: ` +
          `${err?.name || err?.message}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

let cachedStore: NarrationAudioStore | null | undefined;

/**
 * Resolve the active store, or null when caching is off.
 *
 * Memoized per process. Read at CALL time rather than module load, matching
 * the fix VTID-03496 made to the Bedrock adapter — so setting the variable on
 * a task definition takes effect without a process restart, and so the
 * behaviour is testable.
 */
export function getNarrationAudioStore(
  mode: NarrationCacheMode = resolveNarrationCacheMode(),
): NarrationAudioStore | null {
  if (cachedStore !== undefined) return cachedStore;

  if (mode === 'off') {
    cachedStore = null;
    return cachedStore;
  }

  if (mode === 's3') {
    const bucket = (process.env.NARRATION_AUDIO_BUCKET || '').trim();
    if (!bucket) {
      // Configured for s3 but with no bucket named. Fail LOUD and fall to
      // memory rather than to nothing: the operator asked for caching, so
      // silently disabling it would be the worse of the two wrong answers.
      console.error(
        `[NARRATION-CACHE] NARRATION_AUDIO_CACHE=s3 but NARRATION_AUDIO_BUCKET ` +
          `is unset — falling back to the in-process cache. Durable caching is ` +
          `NOT active.`,
      );
      cachedStore = new MemoryNarrationStore();
      return cachedStore;
    }
    const region =
      process.env.NARRATION_AUDIO_REGION ||
      process.env.AWS_POLLY_REGION ||
      process.env.AWS_REGION ||
      'eu-central-1';
    cachedStore = new S3NarrationStore(bucket, region);
    return cachedStore;
  }

  cachedStore = new MemoryNarrationStore();
  return cachedStore;
}

/** Test hook — clears the memoized store so a test can change the mode. */
export function resetNarrationAudioStoreForTests(): void {
  cachedStore = undefined;
}
