/**
 * VTID-04517 — text embeddings for screen matching.
 *
 * Amazon Titan Text Embeddings v2 over Bedrock (standing rule: Bedrock for
 * everything AI, never Google). 512 dimensions, normalized, multilingual.
 * Measured on the navigation test set (2026-09-24): 92% right screen first,
 * 99% within the top five, across all 11 languages; 256 dimensions lost
 * accuracy and 1024 bought nothing.
 *
 * Vectors for every text in the bundled registry ship with the image
 * (data/nav-embeddings.*), so a gateway starts with a ready index and only
 * embeds texts a newer registry added. The same file is the fixture the
 * regression tests run against, because pull-request CI has no AWS access.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const NAV_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const NAV_EMBEDDING_DIMS = 512;

export const EMBEDDINGS_META_PATH = path.join(__dirname, 'data', 'nav-embeddings.json');
export const EMBEDDINGS_BIN_PATH = path.join(__dirname, 'data', 'nav-embeddings.bin');

export interface NavEmbedder {
  readonly model: string;
  readonly dims: number;
  /** Vectors for the given texts, unit length. Throws when it cannot embed. */
  embed(texts: string[]): Promise<Map<string, Float32Array>>;
}

export class NavEmbedderUnavailable extends Error {}

export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const out = new Float32Array(v.length);
  const k = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < v.length; i++) out[i] = v[i] * k;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------------------
// Stored vectors (int8, one scale per row)
// ---------------------------------------------------------------------------

export interface StoredEmbeddingsMeta {
  model: string;
  dims: number;
  texts: string[];
  scales: number[];
}

export function encodeStoredEmbeddings(model: string, dims: number, vectors: Map<string, ArrayLike<number>>): { meta: StoredEmbeddingsMeta; bin: Buffer } {
  const texts = [...vectors.keys()].sort();
  const bin = Buffer.alloc(texts.length * dims);
  const scales: number[] = [];
  texts.forEach((t, row) => {
    const v = vectors.get(t)!;
    if (v.length !== dims) throw new Error(`vector for "${t}" has ${v.length} dims, expected ${dims}`);
    let max = 0;
    for (let i = 0; i < dims; i++) max = Math.max(max, Math.abs(v[i]));
    const scale = max > 0 ? max / 127 : 1;
    scales.push(Number(scale.toPrecision(7)));
    for (let i = 0; i < dims; i++) bin.writeInt8(Math.round(v[i] / scale), row * dims + i);
  });
  return { meta: { model, dims, texts, scales }, bin };
}

export function decodeStoredEmbeddings(meta: StoredEmbeddingsMeta, bin: Buffer): Map<string, Float32Array> {
  if (bin.length !== meta.texts.length * meta.dims) throw new Error('embedding file size does not match its index');
  const out = new Map<string, Float32Array>();
  const raw = new Int8Array(bin.buffer, bin.byteOffset, bin.length);
  meta.texts.forEach((t, row) => {
    const v = new Float32Array(meta.dims);
    for (let i = 0; i < meta.dims; i++) v[i] = raw[row * meta.dims + i] * meta.scales[row];
    out.set(t, normalize(v));
  });
  return out;
}

let bundled: Map<string, Float32Array> | null = null;

/** Vectors shipped with the image; empty when the files are missing. */
export function loadBundledEmbeddings(): Map<string, Float32Array> {
  if (bundled) return bundled;
  try {
    const meta = JSON.parse(fs.readFileSync(EMBEDDINGS_META_PATH, 'utf8')) as StoredEmbeddingsMeta;
    if (meta.model !== NAV_EMBEDDING_MODEL || meta.dims !== NAV_EMBEDDING_DIMS) {
      console.warn(`[nav-embedder] bundled vectors are ${meta.model}/${meta.dims}, expected ${NAV_EMBEDDING_MODEL}/${NAV_EMBEDDING_DIMS}; ignoring them`);
      bundled = new Map();
    } else {
      bundled = decodeStoredEmbeddings(meta, fs.readFileSync(EMBEDDINGS_BIN_PATH));
    }
  } catch (err) {
    console.warn(`[nav-embedder] no bundled vectors (${(err as Error).message})`);
    bundled = new Map();
  }
  return bundled;
}

// ---------------------------------------------------------------------------
// Titan
// ---------------------------------------------------------------------------

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}

export interface TitanNavEmbedderOptions {
  concurrency?: number;
  /** Vectors to reuse instead of calling Bedrock (bundled vectors by default). */
  seed?: Map<string, Float32Array>;
  /** Most query vectors kept in memory. */
  maxCached?: number;
  client?: Pick<BedrockRuntimeClient, 'send'>;
}

export function createTitanNavEmbedder(opts: TitanNavEmbedderOptions = {}): NavEmbedder {
  const concurrency = opts.concurrency ?? 8;
  const maxCached = opts.maxCached ?? 20000;
  const cache = new Map<string, Float32Array>(opts.seed ?? loadBundledEmbeddings());
  let client = opts.client;

  async function embedOne(text: string): Promise<Float32Array> {
    if (!client) {
      if (!process.env.BEDROCK_ROLE_ARN) throw new NavEmbedderUnavailable('BEDROCK_ROLE_ARN is not set');
      client = new BedrockRuntimeClient({
        region: process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1',
        // HTTP/1.1, as in providers/bedrock.ts (VTID-03403).
        requestHandler: new NodeHttpHandler(),
      });
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.send(new InvokeModelCommand({
          modelId: NAV_EMBEDDING_MODEL,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({ inputText: text, dimensions: NAV_EMBEDDING_DIMS, normalize: true }),
        }));
        const body = JSON.parse(new TextDecoder().decode(res.body as Uint8Array));
        if (!Array.isArray(body.embedding) || body.embedding.length !== NAV_EMBEDDING_DIMS) {
          throw new Error('Titan returned no embedding');
        }
        return normalize(body.embedding);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    model: NAV_EMBEDDING_MODEL,
    dims: NAV_EMBEDDING_DIMS,
    async embed(texts) {
      const out = new Map<string, Float32Array>();
      const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
      await pool(missing, concurrency, async (t) => {
        cache.set(t, await embedOne(t));
      });
      for (const t of texts) out.set(t, cache.get(t)!);
      if (cache.size > maxCached) {
        const drop = cache.size - maxCached;
        let k = 0;
        for (const key of cache.keys()) { if (k++ >= drop) break; cache.delete(key); }
      }
      return out;
    },
  };
}

/** An embedder that only knows a fixed set of vectors — used by tests. */
export function createStaticNavEmbedder(vectors: Map<string, Float32Array>): NavEmbedder {
  const first = vectors.values().next().value as Float32Array | undefined;
  return {
    model: NAV_EMBEDDING_MODEL,
    dims: first ? first.length : NAV_EMBEDDING_DIMS,
    async embed(texts) {
      const out = new Map<string, Float32Array>();
      for (const t of texts) {
        const v = vectors.get(t);
        if (!v) throw new NavEmbedderUnavailable(`no stored vector for "${t}"`);
        out.set(t, v);
      }
      return out;
    },
  };
}
