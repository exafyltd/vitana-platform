/**
 * VTID-04517 — the gateway's screen resolver: registry + embeddings + index,
 * kept current in the background.
 *
 * The index is rebuilt when the registry changes (new signature). While a
 * rebuild runs, the previous index keeps answering; before the first index
 * exists, callers get `unavailable` and must fall back rather than guess.
 */
import { createTitanNavEmbedder, NavEmbedder } from './nav-embedder';
import { getNavRegistry, LoadedNavRegistry, refreshNavRegistry } from './nav-registry';
import { buildNavIndex, NavIndex, NavResolution, NavResolveContext, resolveWithIndex } from './nav-resolver';

export type NavServiceResolution = NavResolution | { kind: 'unavailable'; reason: string };

let embedder: NavEmbedder | null = null;
let index: NavIndex | null = null;
let building: { signature: string; promise: Promise<NavIndex | null> } | null = null;
let lastBuildError: string | null = null;

function getEmbedder(): NavEmbedder {
  if (!embedder) embedder = createTitanNavEmbedder();
  return embedder;
}

function ensureIndex(loaded: LoadedNavRegistry): Promise<NavIndex | null> {
  if (index && index.signature === loaded.signature) return Promise.resolve(index);
  if (building && building.signature === loaded.signature) return building.promise;
  const started = Date.now();
  const promise = buildNavIndex(loaded, getEmbedder())
    .then((built) => {
      index = built;
      lastBuildError = null;
      console.log(`[nav-service] index ${built.signature} ready: ${built.docs.length} texts, ${built.screens.size} screens, ${Date.now() - started}ms (${loaded.source})`);
      return built;
    })
    .catch((err: Error) => {
      lastBuildError = err.message;
      console.error(`[nav-service] index build for ${loaded.signature} failed: ${err.message}`);
      return index;
    })
    .finally(() => {
      if (building?.signature === loaded.signature) building = null;
    });
  building = { signature: loaded.signature, promise };
  return promise;
}

/** Load the live registry and build its index. Safe to call at startup. */
export async function warmNavService(): Promise<void> {
  const loaded = await refreshNavRegistry();
  await ensureIndex(loaded);
}

export async function resolveScreenRequest(query: string, ctx: NavResolveContext): Promise<NavServiceResolution> {
  const loaded = getNavRegistry();
  void ensureIndex(loaded);
  const current = index;
  if (!current) return { kind: 'unavailable', reason: lastBuildError || 'screen index is still being built' };
  try {
    return await resolveWithIndex(current, getEmbedder(), query, ctx);
  } catch (err) {
    return { kind: 'unavailable', reason: (err as Error).message };
  }
}

export function navServiceStatus() {
  const loaded = getNavRegistry();
  return {
    registry: { source: loaded.source, signature: loaded.signature, screens: loaded.registry.screens.length, commit: loaded.registry.commit ?? null },
    index: index ? { signature: index.signature, texts: index.docs.length, current: index.signature === loaded.signature } : null,
    building: building?.signature ?? null,
    last_error: lastBuildError,
  };
}

/** Test seam. */
export function __setNavServiceForTests(opts: { embedder?: NavEmbedder | null; index?: NavIndex | null }): void {
  if ('embedder' in opts) embedder = opts.embedder ?? null;
  if ('index' in opts) index = opts.index ?? null;
  building = null;
  lastBuildError = null;
}
