/**
 * VTID-05084 — Loop Engineering catalog (specs/loop-catalog-v1.json) and the
 * service that serves it (src/services/loop-catalog.ts).
 *
 * The coverage rule is the mechanical part of "simplify": every sensor in the
 * four existing registries (Service Health groups, routines/*.md, scheduled
 * workflows, test-contract keys) is owned by exactly one loop or is marked to
 * retire. A new routine, health group, scheduled workflow or contract fails
 * this test until someone names the loop that acts on it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SERVICE_HEALTH_GROUPS } from '../src/constants/service-health-registry';
import { listAllowlistedKeys } from '../src/services/test-contract-commands';
import {
  buildCatalogResponse,
  catalogPath,
  computeCoverage,
  loadCatalog,
  planeSignal,
  resetCatalogCache,
  SENSOR_KINDS,
  SIGNAL_ROW_CAP,
  validateCatalog,
  type LoopCatalog,
  type SensorKind,
} from '../src/services/loop-catalog';

const REPO = path.resolve(__dirname, '../../..');
const raw = (): LoopCatalog => JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
const catalog = raw();

function registry(kind: SensorKind): string[] {
  switch (kind) {
    case 'health_groups':
      return SERVICE_HEALTH_GROUPS;
    case 'test_contracts':
      return listAllowlistedKeys();
    case 'routines':
      return fs.readdirSync(path.join(REPO, 'routines'))
        .filter((f) => f.endsWith('.md') && !f.startsWith('README'))
        .map((f) => f.replace(/\.md$/, ''));
    case 'workflows':
      return fs.readdirSync(path.join(REPO, '.github/workflows'))
        .filter((f) => f.endsWith('.yml'))
        .filter((f) => /^\s*schedule:/m.test(fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8')))
        .map((f) => f.replace(/\.yml$/, ''));
  }
}

const migrations = (): string => fs.readdirSync(path.join(REPO, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8'))
  .join('\n');

describe('VTID-05084 loop catalog — contract', () => {
  it('is valid: every loop carries the full contract', () => {
    expect(validateCatalog(catalog)).toEqual([]);
  });

  it('has 14 loops: 6 platform, 8 product, unique ids L1..L14', () => {
    expect(catalog.loops.map((l) => l.id)).toEqual(Array.from({ length: 14 }, (_, i) => `L${i + 1}`));
    expect(catalog.loops.filter((l) => l.group === 'platform')).toHaveLength(6);
    expect(catalog.loops.filter((l) => l.group === 'product')).toHaveLength(8);
  });

  it('R2/R3 loops have a human gate and R3 loops never execute on their own', () => {
    for (const l of catalog.loops) {
      if (l.risk === 'R2' || l.risk === 'R3') expect(l.human_gate).not.toMatch(/^none\b/i);
      if (l.risk === 'R3') expect(['L0', 'L1', 'L2']).toContain(l.autonomy);
    }
  });

  it('every loop that writes member-facing health, product or creator text uses the claim verifier', () => {
    const uses = (id: string) => catalog.loops.find((l) => l.id === id)!.uses_shared_verifiers;
    for (const id of ['L8', 'L9', 'L10', 'L14']) expect(uses(id)).toContain('claim_verifier');
    expect(uses('L14')).toContain('red_flag_rules');
  });

  it('the guard loop only escalates (L0)', () => {
    expect(catalog.loops.find((l) => l.id === 'L5')!.autonomy).toBe('L0');
  });

  it('folds every one of the 100 v1 cases in exactly once (loops + shared verifiers)', () => {
    const ids = [
      ...catalog.loops.flatMap((l) => l.cases.map((c) => c.id)),
      ...catalog.components.flatMap((c) => (c.cases || []).map((x) => x.id)),
    ];
    const grid = 'PEQVHSCMKG'.split('').flatMap((d) => Array.from({ length: 10 }, (_, i) => `${d}${String(i + 1).padStart(2, '0')}`));
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect([...ids].sort()).toEqual([...grid].sort());
    for (const l of catalog.loops) for (const c of l.cases) expect(c.title.length).toBeGreaterThan(0);
  });

  it('every existing_ref points at something real in this repo', () => {
    const sql = migrations();
    const refs = [
      ...catalog.loops.map((l) => l.existing_ref),
      ...catalog.components.map((c) => c.existing_ref),
    ].filter((r): r is NonNullable<typeof r> => !!r);
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) {
      expect(r.repo).toBe('vitana-platform');
      switch (r.kind) {
        case 'file':
          expect(fs.existsSync(path.join(REPO, r.ref))).toBe(true);
          break;
        case 'glob':
          expect(fs.existsSync(path.join(REPO, r.ref.replace(/\/\*$/, '')))).toBe(true);
          break;
        case 'workflow':
          expect(fs.existsSync(path.join(REPO, '.github/workflows', `${r.ref}.yml`))).toBe(true);
          break;
        case 'routine':
          expect(fs.existsSync(path.join(REPO, 'routines', `${r.ref}.md`))).toBe(true);
          break;
        case 'table':
          expect(sql).toMatch(new RegExp(`create\\s+(table|(or\\s+replace\\s+)?view)\\s+(if\\s+not\\s+exists\\s+)?(public\\.)?${r.ref}\\b`, 'i'));
          break;
        default:
          throw new Error(`unknown ref kind ${(r as { kind: string }).kind}`);
      }
    }
  });

  it('PARTIAL and PLANNED loops name their gap; LIVE and PARTIAL loops say where they run today', () => {
    for (const l of catalog.loops) {
      if (l.status !== 'LIVE') expect(l.gap.length).toBeGreaterThan(0);
      if (l.status !== 'PLANNED') expect(l.existing_ref).not.toBeNull();
    }
  });

  it('lists the known overlaps as the Simplify backlog', () => {
    expect(catalog.overlaps.length).toBeGreaterThanOrEqual(10);
    for (const o of catalog.overlaps) expect(o.items.length).toBeGreaterThanOrEqual(2);
  });

  it('VTID-05098: every overlap says what the Simplify loop did with it', () => {
    const byId = Object.fromEntries(catalog.overlaps.map((o) => [o.id, o.status]));
    expect(byId).toEqual({
      O1: 'resolved', O2: 'resolved', O3: 'resolved', O4: 'resolved', O5: 'resolved',
      O6: 'resolved', O7: 'resolved', O8: 'resolved', O9: 'not_a_duplicate', O10: 'not_a_duplicate',
    });
    for (const o of catalog.overlaps) {
      if (o.status !== 'open') expect((o.resolution || '').length).toBeGreaterThan(20);
    }
  });

  it('VTID-05098: the five retired routines are gone from the repo and from every loop', () => {
    const retired = ['orb-audio-smoke', 'push-pipeline-probe', 'migration-backlog', 'cloud-run-frontend-health', 'self-healing-triage'];
    for (const r of retired) {
      expect(fs.existsSync(path.join(REPO, 'routines', `${r}.md`))).toBe(false);
      for (const l of catalog.loops) expect(l.sensors.routines).not.toContain(r);
    }
  });
});

describe('VTID-05084 coverage rule — every sensor owned by exactly one loop', () => {
  const retired = new Set(catalog.retire_candidates.map((r) => `${r.kind}:${r.ref}`));

  it.each(SENSOR_KINDS)('%s: no orphans, nothing owned twice, no dangling names', (kind) => {
    const known = registry(kind);
    expect(known.length).toBeGreaterThan(0);
    const owners = new Map<string, string[]>();
    for (const l of catalog.loops) for (const s of l.sensors[kind]) owners.set(s, [...(owners.get(s) || []), l.id]);
    const orphans = known.filter((s) => !owners.has(s) && !retired.has(`${kind}:${s}`));
    const twice = [...owners.entries()].filter(([, o]) => o.length > 1).map(([s, o]) => `${s} (${o.join(', ')})`);
    const dangling = [...owners.keys()].filter((s) => !known.includes(s));
    expect({ orphans, twice, dangling }).toEqual({ orphans: [], twice: [], dangling: [] });
  });

  it('the service reports the same clean coverage for the registries compiled into the gateway', () => {
    const cov = computeCoverage(catalog);
    for (const k of ['health_groups', 'test_contracts'] as const) {
      expect(cov.live[k].orphans).toEqual([]);
      expect(cov.live[k].double_owned).toEqual([]);
      expect(cov.live[k].unknown).toEqual([]);
      expect(cov.live[k].owned).toBe(cov.live[k].total);
    }
    expect(cov.ci_enforced.routines.owned).toBe(registry('routines').length);
    expect(cov.ci_enforced.workflows.owned).toBe(registry('workflows').length);
  });

  it('computeCoverage detects an orphan, a double owner and an unknown name', () => {
    const c = raw();
    c.loops[0].sensors.health_groups = c.loops[0].sensors.health_groups.filter((g) => g !== 'Commerce');
    c.loops[1].sensors.test_contracts = ['gateway.alive', 'no.such.contract'];
    const cov = computeCoverage(c);
    expect(cov.live.health_groups.orphans).toEqual(['Commerce']);
    expect(cov.live.test_contracts.double_owned).toEqual(['gateway.alive']);
    expect(cov.live.test_contracts.unknown).toEqual(['no.such.contract']);
  });
});

describe('VTID-05084 validateCatalog rejects broken contracts', () => {
  it('VTID-05098: flags an unknown overlap status and a closed overlap without a resolution', () => {
    const c = raw();
    (c.overlaps[0] as any).status = 'done';
    c.overlaps[1].resolution = '';
    expect(validateCatalog(c)).toEqual(expect.arrayContaining([
      'overlap O1: bad status done',
      'overlap O2: resolved needs a resolution',
    ]));
  });

  it('flags a missing field, an R2 loop without a gate and an R3 loop at L3', () => {
    const c = raw();
    c.loops[0].goal = '';
    c.loops[5].human_gate = 'None.';
    c.loops[13].autonomy = 'L3';
    const errors = validateCatalog(c);
    expect(errors).toEqual(expect.arrayContaining([
      'loop L1: missing contract field goal',
      'loop L6: R2 loop needs a human gate',
      'loop L14: R3 loop may not exceed L2',
    ]));
  });

  it('loadCatalog throws loudly on an invalid file', () => {
    resetCatalogCache();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => loadCatalog(() => JSON.stringify({ loops: [{ id: 'X' }] }))).toThrow(/loop catalog invalid/);
    err.mockRestore();
    resetCatalogCache();
  });
});

function fakeSb(result: { data?: unknown[]; error?: { message: string } }, calls: Array<Record<string, unknown>> = []) {
  return {
    from(table: string) {
      const call: Record<string, unknown> = { table };
      calls.push(call);
      const chain: any = {
        select: (cols: string) => { call.select = cols; return chain; },
        eq: (k: string, v: unknown) => { call[`eq:${k}`] = v; return chain; },
        gte: (k: string, v: unknown) => { call[`gte:${k}`] = v; return chain; },
        order: () => chain,
        limit: (n: number) => { call.limit = n; return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }); },
      };
      return chain;
    },
  } as any;
}

describe('VTID-05084 plane signal (agent_runs_unified, read-only)', () => {
  beforeEach(() => resetCatalogCache());

  it('counts 7 days of runs per status for one plane', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const now = Date.parse('2026-10-12T12:00:00Z');
    const sb = fakeSb({ data: [
      { status: 'succeeded', created_at: '2026-10-12T11:00:00Z' },
      { status: 'failed', created_at: '2026-10-11T11:00:00Z' },
      { status: 'succeeded', created_at: '2026-10-10T11:00:00Z' },
    ] }, calls);
    const s = await planeSignal(sb, 'self_healing', now);
    expect(s).toEqual({ state: 'ok', window_days: 7, total: 3, by_status: { succeeded: 2, failed: 1 }, last_run_at: '2026-10-12T11:00:00Z', capped: false });
    expect(calls[0]).toMatchObject({ table: 'agent_runs_unified', 'eq:plane': 'self_healing', 'gte:created_at': '2026-10-05T12:00:00.000Z', limit: SIGNAL_ROW_CAP });
  });

  it('marks a capped window', async () => {
    const rows = Array.from({ length: SIGNAL_ROW_CAP }, () => ({ status: 'succeeded', created_at: '2026-10-12T00:00:00Z' }));
    const s = await planeSignal(fakeSb({ data: rows }), 'dev_autopilot');
    expect(s.state === 'ok' && s.capped).toBe(true);
  });

  it('degrades to unavailable on a view error or no client, never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await planeSignal(fakeSb({ error: { message: 'boom' } }), 'self_healing')).toEqual({ state: 'unavailable' });
    expect(await planeSignal(null, 'dev_autopilot')).toEqual({ state: 'unavailable' });
    warn.mockRestore();
  });

  it('caches a plane for 60 s', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sb = fakeSb({ data: [] }, calls);
    await planeSignal(sb, 'self_healing', 1_000_000);
    await planeSignal(sb, 'self_healing', 1_030_000);
    expect(calls).toHaveLength(1);
    await planeSignal(sb, 'self_healing', 1_061_000);
    expect(calls).toHaveLength(2);
  });

  it('buildCatalogResponse serves the catalog even when no signal is available', async () => {
    const r = await buildCatalogResponse(null);
    expect(r.totals.loops).toBe(14);
    expect(r.totals.cases).toBe(100);
    expect(r.totals.by_status).toEqual({ LIVE: 2, PARTIAL: 9, PLANNED: 3 });
    expect(Object.keys(r.signals).sort()).toEqual(['community_autopilot', 'dev_autopilot', 'self_healing']);
    for (const s of Object.values(r.signals)) expect(s).toEqual({ state: 'unavailable' });
  });
});
