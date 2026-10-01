/**
 * VTID-04517 — the registry resolver on committed data: the bundled registry
 * snapshot and its stored Titan vectors. No network, no AWS — pull-request
 * CI has neither.
 */
import { createStaticNavEmbedder, loadBundledEmbeddings, NavEmbedder } from '../../src/navigation/nav-embedder';
import { loadSnapshotRegistry, pageOf } from '../../src/navigation/nav-registry';
import { buildNavIndex, NavIndex, NavResolveContext, resolveWithIndex } from '../../src/navigation/nav-resolver';
import type { GoldenCase } from './golden-set';
import type { NavResolution as HarnessResolution } from './harness';

export interface RegistryFixture {
  index: NavIndex;
  embedder: NavEmbedder;
}

let fixture: Promise<RegistryFixture> | null = null;

export function loadRegistryFixture(): Promise<RegistryFixture> {
  if (!fixture) {
    fixture = (async () => {
      const embedder = createStaticNavEmbedder(loadBundledEmbeddings());
      return { index: await buildNavIndex(loadSnapshotRegistry(), embedder), embedder };
    })();
  }
  return fixture;
}

/** Golden ids written before Phase 1 merged screens; map them to live ids. */
export function liveIds(index: NavIndex, ids: string[]): string[] {
  return [...new Set(ids.map((id) => index.formerIds.get(id) || id))];
}

export function pageOfScreen(index: NavIndex, id: string): string | null {
  const s = index.screens.get(id);
  return s ? pageOf(s.route) : null;
}

/**
 * The resolver as the new tools use it. With `holdout`, registry texts
 * identical to the utterance are ignored: many golden sentences were copied
 * into the registry as phrasings, and matching a sentence to itself proves
 * nothing about the next way a member phrases it.
 *
 * The voice model tells the tool what
 * the member asked for (open vs. where); small talk is resolved as a
 * "where" question, the worst case — it must still never produce a screen.
 */
export async function registryResolve(f: RegistryFixture, c: GoldenCase, holdout = true): Promise<HarnessResolution> {
  const ctx: NavResolveContext = {
    ignoreText: holdout ? c.utterance : undefined,
    lang: c.lang,
    authenticated: true,
    viewport: c.platform === 'mobile' ? 'mobile' : c.platform === 'desktop' ? 'desktop' : undefined,
  };
  const r = await resolveWithIndex(f.index, f.embedder, c.utterance.trim(), ctx);
  if (r.kind === 'match') return { outcome: c.intent === 'open' ? 'open' : 'offer', screen_id: r.screen.screen_id };
  if (r.kind === 'ambiguous') return { outcome: 'clarify', screen_id: null, candidates: r.candidates.map((x) => x.screen_id) };
  return { outcome: 'none', screen_id: null };
}
