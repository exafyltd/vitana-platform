/**
 * VTID-04517 — registry resolver units: who can reach what, how sure the
 * resolver must be before a screen opens, and the registry/vector plumbing.
 * Tiny hand-made vectors; the real-data checks live in test/nav-golden/.
 */
import {
  createStaticNavEmbedder,
  decodeStoredEmbeddings,
  encodeStoredEmbeddings,
  normalize,
} from '../../src/navigation/nav-embedder';
import {
  __setNavRegistryForTests,
  getNavRegistry,
  LoadedNavRegistry,
  loadSnapshotRegistry,
  NavRegistry,
  NavScreen,
  pageOf,
  refreshNavRegistry,
  registrySignature,
  validateNavRegistry,
} from '../../src/navigation/nav-registry';
import { buildNavIndex, NAV_THRESHOLDS, resolveWithIndex } from '../../src/navigation/nav-resolver';

const v = (...xs: number[]) => normalize(xs);

function screen(id: string, route: string, title: string, extra: Partial<NavScreen> = {}): NavScreen {
  return { id, route, category: 'test', access: 'member', i18n: { en: { title }, de: { title: `${title} DE` } }, ...extra };
}

function loaded(screens: NavScreen[]): LoadedNavRegistry {
  const registry: NavRegistry = { version: 1, screens };
  return { registry, signature: registrySignature(registry), source: 'snapshot', loaded_at: 0 };
}

// Axes: 0 news, 1 cart, 2 wallet, 3 settings.
const VECS = new Map<string, Float32Array>([
  ['News', v(1, 0, 0, 0)], ['News DE', v(1, 0, 0, 0)],
  ['All news', v(0.97, 0.05, 0, 0)], ['All news DE', v(0.97, 0.05, 0, 0)],
  ['Cart', v(0, 1, 0, 0)], ['Cart DE', v(0, 1, 0, 0)],
  ['Wallet', v(0, 0, 1, 0)], ['Wallet DE', v(0, 0, 1, 0)],
  ['Wallet popup', v(0, 0, 1, 0)], ['Wallet popup DE', v(0, 0, 1, 0)],
  ['Terms', v(0, 0, 0, 1)], ['Terms DE', v(0, 0, 0, 1)],
  ['Mobile only', v(0, 0.2, 0, 1)], ['Mobile only DE', v(0, 0.2, 0, 1)],
  ['q:news', v(1, 0, 0, 0)],
  ['q:cart', v(0.1, 1, 0, 0)],
  ['q:between', v(1, 1, 0, 0)],
  ['q:nothing', v(0.2, -0.3, -0.4, 0.2)],
  ['q:wallet', v(0, 0, 1, 0)],
  ['q:terms', v(0, 0, 0, 1)],
]);

const SCREENS = [
  screen('HOME.OVERVIEW', '/home', 'News', { mobileRoute: '/m/home' }),
  screen('HOME.NEWS_ALL', '/home?tab=all', 'All news'),
  screen('DISCOVER.CART', '/universal-cart', 'Cart'),
  screen('WALLET.OVERVIEW', '/wallet', 'Wallet', { formerIds: ['WALLET.OLD'] }),
  screen('OVERLAY.WALLET_POPUP', '/wallet', 'Wallet popup', { disabled: 'no listener', overlay: { event: 'x' } }),
  screen('PUBLIC.TERMS', '/terms', 'Terms', { access: 'public' }),
  screen('MOBILE.ONLY', '/mobile-only', 'Mobile only', { viewport: 'mobile' }),
  screen('ENTITY.DETAIL', '/thing/:id', 'Thing', { params: ['id'] }),
];

async function index() {
  const embedder = createStaticNavEmbedder(VECS);
  return { embedder, index: await buildNavIndex(loaded(SCREENS), embedder) };
}

describe('VTID-04517 registry resolver', () => {
  it('opens a clear match, with the route for the viewport', async () => {
    const { index: ix, embedder } = await index();
    const r = await resolveWithIndex(ix, embedder, 'q:news', { authenticated: true, viewport: 'mobile', lang: 'de' });
    expect(r.kind).toBe('match');
    if (r.kind !== 'match') return;
    expect(r.screen).toMatchObject({ screen_id: 'HOME.OVERVIEW', route: '/m/home', title: 'News DE' });
  });

  it('measures the lead against another page, so a page and its tab do not block a match', async () => {
    const { index: ix, embedder } = await index();
    // HOME.NEWS_ALL scores ~0.97 against HOME.OVERVIEW's 1.0 — same page.
    const r = await resolveWithIndex(ix, embedder, 'q:news', { authenticated: true });
    expect(r.kind).toBe('match');
    expect(r.candidates.map((c) => c.screen_id).slice(0, 2)).toEqual(['HOME.OVERVIEW', 'HOME.NEWS_ALL']);
    expect(r.page_gap).toBeGreaterThanOrEqual(NAV_THRESHOLDS.pageGap);
  });

  it('hands back candidates when two pages are equally close', async () => {
    const { index: ix, embedder } = await index();
    const r = await resolveWithIndex(ix, embedder, 'q:between', { authenticated: true });
    expect(r.kind).toBe('ambiguous');
    expect(r.candidates.map((c) => c.screen_id)).toEqual(expect.arrayContaining(['HOME.OVERVIEW', 'DISCOVER.CART']));
  });

  it('returns nothing when no screen is close', async () => {
    const { index: ix, embedder } = await index();
    const r = await resolveWithIndex(ix, embedder, 'q:nothing', { authenticated: true });
    expect(r).toMatchObject({ kind: 'none', candidates: [] });
  });

  it('never offers disabled screens or screens that need an entity', async () => {
    const { index: ix, embedder } = await index();
    const r = await resolveWithIndex(ix, embedder, 'q:wallet', { authenticated: true });
    const ids = r.candidates.map((c) => c.screen_id);
    expect(ids).toContain('WALLET.OVERVIEW');
    expect(ids).not.toContain('OVERLAY.WALLET_POPUP');
    expect([...ix.docs].some((d) => d.screenId === 'ENTITY.DETAIL')).toBe(false);
  });

  it('only offers public screens to anonymous visitors', async () => {
    const { index: ix, embedder } = await index();
    expect((await resolveWithIndex(ix, embedder, 'q:cart', { authenticated: false })).candidates).toEqual([]);
    const terms = await resolveWithIndex(ix, embedder, 'q:terms', { authenticated: false });
    expect(terms.kind).toBe('match');
  });

  it('respects the viewport and tenant exclusions', async () => {
    const { index: ix, embedder } = await index();
    const desktop = await resolveWithIndex(ix, embedder, 'q:terms', { authenticated: true, viewport: 'desktop' });
    expect(desktop.candidates.map((c) => c.screen_id)).not.toContain('MOBILE.ONLY');
    const mobile = await resolveWithIndex(ix, embedder, 'q:terms', { authenticated: true, viewport: 'mobile' });
    expect(mobile.candidates.map((c) => c.screen_id)).toContain('MOBILE.ONLY');
    const excluded = await resolveWithIndex(ix, embedder, 'q:cart', { authenticated: true, excluded: new Set(['DISCOVER.CART']) });
    expect(excluded.candidates.map((c) => c.screen_id)).not.toContain('DISCOVER.CART');
  });

  it('maps retired ids to the screen that replaced them', async () => {
    const { index: ix } = await index();
    expect(ix.formerIds.get('WALLET.OLD')).toBe('WALLET.OVERVIEW');
  });

  it('fails loudly when a registry text has no vector', async () => {
    const embedder = createStaticNavEmbedder(new Map([['News', v(1, 0, 0, 0)]]));
    await expect(buildNavIndex(loaded([screen('A.B', '/a', 'Unknown')]), embedder)).rejects.toThrow();
  });

  it('pins the thresholds the test set was measured with', () => {
    expect(NAV_THRESHOLDS).toEqual({ match: 0.65, pageGap: 0.2, candidateFloor: 0.45, maxCandidates: 5 });
  });
});

describe('VTID-04517 registry loading', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.NAV_REGISTRY_URL;
    __setNavRegistryForTests(null);
  });

  it('bundles a valid snapshot of every voice screen', () => {
    const snap = loadSnapshotRegistry();
    expect(validateNavRegistry(snap.registry)).toEqual([]);
    expect(snap.registry.screens.length).toBeGreaterThan(150);
  });

  it('rejects malformed registries', () => {
    expect(validateNavRegistry({})).not.toEqual([]);
    expect(validateNavRegistry({ screens: [] })).not.toEqual([]);
    expect(validateNavRegistry({ screens: [screen('A.B', '/a', 'x'), screen('A.B', '/b', 'y')] })).toContain('duplicate id A.B');
    expect(validateNavRegistry({ screens: [{ ...screen('A.B', 'a', 'x') }] })).toContain('A.B: bad route');
  });

  it('adopts the live registry when it is valid', async () => {
    process.env.NAV_REGISTRY_URL = 'https://example.test/nav-registry.json';
    const reg = { version: 1, screens: [screen('A.B', '/a', 'A')] };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => reg }) as unknown as typeof fetch;
    const r = await refreshNavRegistry();
    expect(r.source).toBe('remote');
    expect(r.registry.screens.map((s) => s.id)).toEqual(['A.B']);
  });

  it('keeps the snapshot when the live registry is unreachable or invalid', async () => {
    process.env.NAV_REGISTRY_URL = 'https://example.test/nav-registry.json';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    expect((await refreshNavRegistry()).source).toBe('snapshot');
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ screens: [] }) }) as unknown as typeof fetch;
    expect((await refreshNavRegistry()).source).toBe('snapshot');
    expect(getNavRegistry().source).toBe('snapshot');
  });

  it('groups a page with its tabs', () => {
    expect(pageOf('/home?tab=all')).toBe('/home');
    expect(pageOf('/home/')).toBe('/home');
  });
});

describe('VTID-04517 stored vectors', () => {
  it('round-trips through int8 storage without changing a score by more than 0.01', () => {
    const vecs = new Map<string, Float32Array>();
    for (let k = 0; k < 20; k++) vecs.set(`t${k}`, normalize(Array.from({ length: 512 }, (_, i) => Math.sin(i * (k + 1) * 0.37))));
    const { meta, bin } = encodeStoredEmbeddings('m', 512, vecs);
    const back = decodeStoredEmbeddings(meta, bin);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    for (const a of vecs.keys()) for (const b of vecs.keys()) {
      expect(Math.abs(dot(vecs.get(a)!, vecs.get(b)!) - dot(back.get(a)!, back.get(b)!))).toBeLessThan(0.01);
    }
  });
});
