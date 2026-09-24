/**
 * VTID-04517 — resolve a spoken request to a screen.
 *
 * Replaces the keyword scorer in navigator-consult.ts, whose scores were
 * normalised so the best match always read 100 — which is how "show me the
 * news" could land on the cart. Here every registry text (titles,
 * descriptions, phrasings, in all 11 languages) is an embedding; a request
 * scores each screen by its closest text, and the result says how sure it is:
 *
 *   match      — one screen is clearly the answer. The dispatcher may open it
 *                directly when the user asked to open something.
 *   ambiguous  — plausible screens, none clearly ahead. The voice model picks
 *                from `candidates` or asks the user which one.
 *   none       — nothing in the app is close. Never navigate.
 *
 * "Clearly ahead" is measured against the best screen on a DIFFERENT PAGE:
 * a page and its tabs (Orders / Active orders) sit close together by design,
 * and landing on the right page is never the failure members report.
 *
 * Thresholds were fixed on the Phase 0 test set and on leave-one-out over
 * every registry phrasing (docs/navigation-rebuild/PLAN.md); tests pin them.
 */
import { NavEmbedder } from './nav-embedder';
import { isVoiceTarget, LoadedNavRegistry, NavScreen, pageOf } from './nav-registry';

export const NAV_THRESHOLDS = {
  /** Top score needed before a screen can be opened without asking. */
  match: 0.65,
  /** Lead over the best screen on another page needed for the same. */
  pageGap: 0.2,
  /** Below this a screen is not offered at all. */
  candidateFloor: 0.45,
  maxCandidates: 5,
} as const;

/** Descriptions say less about how people ask than titles and phrasings do. */
const KIND_WEIGHT = { phrasing: 1, title: 0.95, shows: 0.85 } as const;
type DocKind = keyof typeof KIND_WEIGHT;

export interface NavIndexDoc {
  screenId: string;
  kind: DocKind;
  lang: string;
  text: string;
  vec: Float32Array;
}

export interface NavIndex {
  signature: string;
  model: string;
  dims: number;
  screens: Map<string, NavScreen>;
  docs: NavIndexDoc[];
  /** Retired id → live id, from `formerIds`. */
  formerIds: Map<string, string>;
  /** Doc vectors row by row, pre-multiplied by their kind weight. */
  matrix: Float32Array;
  /** Screen of each doc, as an index into `screenIds`. */
  docScreen: Int32Array;
  /** Lower-cased doc texts, for evaluation hold-outs. */
  docLower: string[];
  screenIds: string[];
}

/** Every text the index embeds for a registry. */
export function registryDocTexts(loaded: LoadedNavRegistry): Array<Omit<NavIndexDoc, 'vec'>> {
  const out: Array<Omit<NavIndexDoc, 'vec'>> = [];
  for (const s of loaded.registry.screens) {
    if (!isVoiceTarget(s)) continue;
    for (const [lang, t] of Object.entries(s.i18n || {})) {
      if (!t) continue;
      if (t.title?.trim()) out.push({ screenId: s.id, kind: 'title', lang, text: t.title.trim() });
      for (const p of t.phrasings || []) if (p?.trim()) out.push({ screenId: s.id, kind: 'phrasing', lang, text: p.trim() });
      if (t.shows?.trim()) out.push({ screenId: s.id, kind: 'shows', lang, text: t.shows.trim() });
    }
  }
  return out;
}

export async function buildNavIndex(loaded: LoadedNavRegistry, embedder: NavEmbedder): Promise<NavIndex> {
  const docs = registryDocTexts(loaded);
  const vectors = await embedder.embed(docs.map((d) => d.text));
  const formerIds = new Map<string, string>();
  for (const s of loaded.registry.screens) for (const f of s.formerIds || []) formerIds.set(f, s.id);
  const dims = embedder.dims;
  const screenIds = [...new Set(docs.map((d) => d.screenId))];
  const screenPos = new Map(screenIds.map((id, i) => [id, i]));
  const matrix = new Float32Array(docs.length * dims);
  const docScreen = new Int32Array(docs.length);
  const full = docs.map((d, row) => {
    const vec = vectors.get(d.text);
    if (!vec || vec.length !== dims) throw new Error(`no ${dims}-dim vector for "${d.text}"`);
    const w = KIND_WEIGHT[d.kind];
    for (let i = 0; i < dims; i++) matrix[row * dims + i] = vec[i] * w;
    docScreen[row] = screenPos.get(d.screenId)!;
    return { ...d, vec };
  });
  return {
    signature: loaded.signature,
    model: embedder.model,
    dims,
    screens: new Map(loaded.registry.screens.map((s) => [s.id, s])),
    docs: full,
    formerIds,
    matrix,
    docScreen,
    docLower: docs.map((d) => d.text.toLowerCase()),
    screenIds,
  };
}

export interface NavResolveContext {
  /** Session language; picks the title Vitana says. */
  lang?: string;
  viewport?: 'mobile' | 'desktop';
  authenticated: boolean;
  /** Screen ids switched off for this tenant (Command Hub override). */
  excluded?: ReadonlySet<string>;
  /** Evaluation only: ignore registry texts equal to this (case-insensitive). */
  ignoreText?: string;
}

export interface NavCandidate {
  screen_id: string;
  score: number;
  title: string;
  /** Route for the caller's viewport. */
  route: string;
  shows?: string;
}

export type NavResolution =
  | { kind: 'match'; screen: NavCandidate; candidates: NavCandidate[]; top_score: number; page_gap: number }
  | { kind: 'ambiguous'; candidates: NavCandidate[]; top_score: number; page_gap: number }
  | { kind: 'none'; candidates: []; top_score: number; page_gap: number };

export function isReachable(s: NavScreen, ctx: NavResolveContext): boolean {
  if (!isVoiceTarget(s)) return false;
  if (!ctx.authenticated && s.access !== 'public') return false;
  if (ctx.viewport && s.viewport && s.viewport !== ctx.viewport) return false;
  if (ctx.excluded?.has(s.id)) return false;
  return true;
}

export function routeFor(s: NavScreen, viewport?: 'mobile' | 'desktop'): string {
  return viewport === 'mobile' && s.mobileRoute ? s.mobileRoute : s.route;
}

export function candidateFor(s: NavScreen, score: number, ctx: Pick<NavResolveContext, 'lang' | 'viewport'>): NavCandidate {
  const lang = (ctx.lang || 'en').split('-')[0].toLowerCase();
  const text = s.i18n[lang] || s.i18n.en;
  return {
    screen_id: s.id,
    score: Math.round(score * 1000) / 1000,
    title: text?.title || s.i18n.en.title,
    route: routeFor(s, ctx.viewport),
    shows: text?.shows || s.i18n.en.shows,
  };
}

/** Every reachable screen with its best score, best first. */
export function rankScreens(index: NavIndex, query: Float32Array, ctx: NavResolveContext): Array<[string, number]> {
  const nScreens = index.screenIds.length;
  const reachable = new Uint8Array(nScreens);
  for (let i = 0; i < nScreens; i++) {
    const s = index.screens.get(index.screenIds[i]);
    reachable[i] = s && isReachable(s, ctx) ? 1 : 0;
  }
  const best = new Float64Array(nScreens).fill(-Infinity);
  const ignore = ctx.ignoreText?.trim().toLowerCase();
  const { matrix, docScreen, dims, docLower } = index;
  for (let row = 0; row < docScreen.length; row++) {
    const sc = docScreen[row];
    if (!reachable[sc]) continue;
    if (ignore !== undefined && docLower[row] === ignore) continue;
    let score = 0;
    const off = row * dims;
    for (let i = 0; i < dims; i++) score += query[i] * matrix[off + i];
    if (score > best[sc]) best[sc] = score;
  }
  const out: Array<[string, number]> = [];
  for (let i = 0; i < nScreens; i++) if (best[i] > -Infinity) out.push([index.screenIds[i], best[i]]);
  return out.sort((a, b) => b[1] - a[1]);
}

/** Lead of the top screen over the best screen on another page. */
export function pageGap(index: NavIndex, ranked: Array<[string, number]>): number {
  if (!ranked.length) return 0;
  const topPage = pageOf(index.screens.get(ranked[0][0])!.route);
  const other = ranked.find(([id]) => pageOf(index.screens.get(id)!.route) !== topPage);
  return ranked[0][1] - (other ? other[1] : 0);
}

export function decide(index: NavIndex, ranked: Array<[string, number]>, ctx: NavResolveContext): NavResolution {
  const top = ranked[0]?.[1] ?? 0;
  const gap = pageGap(index, ranked);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const candidates = ranked
    .filter(([, s]) => s >= NAV_THRESHOLDS.candidateFloor)
    .slice(0, NAV_THRESHOLDS.maxCandidates)
    .map(([id, s]) => candidateFor(index.screens.get(id)!, s, ctx));
  if (!candidates.length) return { kind: 'none', candidates: [], top_score: round(top), page_gap: round(gap) };
  if (top >= NAV_THRESHOLDS.match && gap >= NAV_THRESHOLDS.pageGap) {
    return { kind: 'match', screen: candidates[0], candidates, top_score: round(top), page_gap: round(gap) };
  }
  return { kind: 'ambiguous', candidates, top_score: round(top), page_gap: round(gap) };
}

export async function resolveWithIndex(
  index: NavIndex,
  embedder: NavEmbedder,
  query: string,
  ctx: NavResolveContext,
): Promise<NavResolution> {
  const q = query.trim();
  if (!q) return { kind: 'none', candidates: [], top_score: 0, page_gap: 0 };
  const vec = (await embedder.embed([q])).get(q)!;
  return decide(index, rankScreens(index, vec, ctx), ctx);
}
