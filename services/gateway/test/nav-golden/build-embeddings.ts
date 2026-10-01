/**
 * VTID-04517 — regenerate src/navigation/data/nav-embeddings.{json,bin}.
 *
 * Run after refreshing the bundled registry snapshot
 * (src/navigation/data/nav-registry.snapshot.json, copied from a vitana-v1
 * build's public/nav-registry.json) or after adding golden or redirect cases:
 *
 *   BEDROCK_ROLE_ARN=local npx tsx test/nav-golden/build-embeddings.ts
 *
 * Needs AWS credentials that may call bedrock:InvokeModel on
 * amazon.titan-embed-text-v2:0 in eu-central-1. Vectors already in the file
 * are reused, so only new texts are embedded. Texts no longer used are
 * dropped. Optional SEED_JSON=<file> adds vectors from a {map:{text:vec}}
 * dump.
 */
import * as fs from 'fs';
import {
  createTitanNavEmbedder,
  EMBEDDINGS_BIN_PATH,
  EMBEDDINGS_META_PATH,
  encodeStoredEmbeddings,
  loadBundledEmbeddings,
  NAV_EMBEDDING_DIMS,
  NAV_EMBEDDING_MODEL,
  normalize,
} from '../../src/navigation/nav-embedder';
import { loadSnapshotRegistry } from '../../src/navigation/nav-registry';
import { registryDocTexts } from '../../src/navigation/nav-resolver';
import { GOLDEN_SET } from './golden-set';
import { PARAPHRASE_CASES, REDIRECT_CASES } from '../nav-redirect/redirect-cases';

(async () => {
  const seed = new Map(loadBundledEmbeddings());
  if (process.env.SEED_JSON) {
    const { map } = JSON.parse(fs.readFileSync(process.env.SEED_JSON, 'utf8')) as { map: Record<string, number[]> };
    for (const [t, v] of Object.entries(map)) if (!seed.has(t) && v.length === NAV_EMBEDDING_DIMS) seed.set(t, normalize(v));
  }
  const texts = [...new Set([
    ...registryDocTexts(loadSnapshotRegistry()).map((d) => d.text),
    ...GOLDEN_SET.map((g) => g.utterance.trim()),
    ...REDIRECT_CASES.map((c) => c.say.trim()),
    ...PARAPHRASE_CASES.flatMap((p) => [p.say.trim(), p.modelQuestion.trim()]),
  ])];
  const missing = texts.filter((t) => !seed.has(t)).length;
  console.log(`${texts.length} texts, ${missing} to embed`);
  const vectors = await createTitanNavEmbedder({ seed, concurrency: 12 }).embed(texts);
  const { meta, bin } = encodeStoredEmbeddings(NAV_EMBEDDING_MODEL, NAV_EMBEDDING_DIMS, vectors);
  fs.writeFileSync(EMBEDDINGS_META_PATH, JSON.stringify(meta));
  fs.writeFileSync(EMBEDDINGS_BIN_PATH, bin);
  console.log(`wrote ${meta.texts.length} vectors (${(bin.length / 1e6).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
