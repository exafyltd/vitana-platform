/**
 * VTID-03277 — Guided Journey checklist (P2) tests.
 *  - validator rules (90/250, per-session counts, labels, scripts, targets, gating)
 *  - publish blocks on invalid, succeeds + snapshots on valid; rollback flips current
 *  - HTTP: admin 401/403/200, publish 422 on invalid, public read fallback
 */

import request from 'supertest';
import express from 'express';

import { validateChecklist } from '../src/services/guided-journey/checklist-validator';
import {
  publishChecklist,
  rollbackChecklist,
  ChecklistValidationError,
} from '../src/services/guided-journey/checklist-publish';
import { getPublishedChecklist, getOrbTopicSeed, normalizeVoiceLocale } from '../src/services/guided-journey/checklist-service';
import type { ChecklistTopic } from '../src/types/journey-checklist';

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------
function chapterFor(s: number): string {
  if (s <= 15) return 'basics';
  if (s <= 30) return 'daily_use';
  if (s <= 45) return 'community';
  if (s <= 60) return 'health';
  if (s <= 75) return 'intelligence';
  return 'discovery';
}
function gateFor(s: number): ChecklistTopic['businessGate'] {
  if (s >= 76) return 'builder';
  if (s >= 70) return 'active';
  if (s >= 60) return 'curious';
  return null;
}

let topicSeq = 0;
function mkTopic(session: number, position: number, over: Partial<ChecklistTopic> = {}): ChecklistTopic {
  topicSeq++;
  const id = `T${String(topicSeq).padStart(3, '0')}`;
  return {
    topicId: id,
    curriculumVersion: 'v2',
    session,
    position,
    chapterId: chapterFor(session),
    displayLabel: 'Sample Topic',
    title: null,
    shortDescription: null,
    vitanaVoiceScript: 'Vitana explains this topic.',
    explanation: { whatItIs: 'x', userBenefit: 'y', whenToUse: 'z', tryThis: 'do it' },
    guidedPracticeTarget: 'life_compass',
    practiceActionType: 'orb_explain',
    completionEvent: `done_${id}`,
    unlockRule: null,
    safetyLevel: 'standard',
    businessGate: gateFor(session),
    sourceRefs: [],
    manualPath: null,
    fallbackTopicId: null,
    status: 'draft',
    enabled: true,
    updatedByAdminId: null,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:00.000Z',
  };
}

/** A fully valid 90-session / 250-topic working set. */
function fullValidSet(): ChecklistTopic[] {
  topicSeq = 0;
  const out: ChecklistTopic[] = [];
  for (let s = 1; s <= 90; s++) {
    const n = s <= 20 ? 2 : 3;
    for (let p = 1; p <= n; p++) out.push(mkTopic(s, p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory fake Supabase client
// ---------------------------------------------------------------------------
let verSeq = 0;
function makeFakeSupabase(seedTopics: ChecklistTopic[] = []) {
  const topics = new Map<string, any>();
  for (const t of seedTopics) {
    topics.set(t.topicId, {
      topic_id: t.topicId,
      curriculum_version: t.curriculumVersion,
      session: t.session,
      position: t.position,
      chapter_id: t.chapterId,
      display_label: t.displayLabel,
      title: t.title,
      short_description: t.shortDescription,
      vitana_voice_script: t.vitanaVoiceScript,
      explanation_what_it_is: t.explanation.whatItIs,
      explanation_user_benefit: t.explanation.userBenefit,
      explanation_when_to_use: t.explanation.whenToUse,
      explanation_try_this: t.explanation.tryThis,
      guided_practice_target: t.guidedPracticeTarget,
      practice_action_type: t.practiceActionType,
      completion_event: t.completionEvent,
      unlock_rule: t.unlockRule,
      safety_level: t.safetyLevel,
      business_gate: t.businessGate,
      source_refs: t.sourceRefs,
      manual_path: t.manualPath,
      fallback_topic_id: t.fallbackTopicId,
      status: t.status,
      enabled: t.enabled,
      updated_by_admin_id: t.updatedByAdminId,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    });
  }
  const store: Record<string, any[]> = {
    journey_checklist_topics: Array.from(topics.values()),
    journey_checklist_versions: [],
    journey_checklist_audit: [],
    journey_checklist_translations: [],
  };

  function from(table: string) {
    const st: any = { table, op: 'select', eqs: [], ilikes: [], orders: [], payload: null };

    function rowsOf() {
      return store[table];
    }
    function run(): any[] {
      if (st.op === 'select' || st.op === 'update' || st.op === 'delete') {
        let rows = rowsOf().filter((r: any) => st.eqs.every(([c, v]: any) => r[c] === v));
        for (const [c, sub] of st.ilikes) {
          rows = rows.filter((r: any) => String(r[c] ?? '').toLowerCase().includes(sub));
        }
        if (st.op === 'select' && st.orders.length) {
          rows = rows.slice().sort((a: any, b: any) => {
            for (const o of st.orders) {
              const av = a[o.col], bv = b[o.col];
              if (av < bv) return o.asc ? -1 : 1;
              if (av > bv) return o.asc ? 1 : -1;
            }
            return 0;
          });
        }
        if (st.op === 'update') for (const r of rows) Object.assign(r, st.payload);
        return rows;
      }
      if (st.op === 'insert') {
        const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
        const inserted: any[] = [];
        for (const p of arr) {
          const row = { ...p };
          if (table === 'journey_checklist_versions' && !row.id) row.id = `ver-${++verSeq}`;
          if (table === 'journey_checklist_audit' && !row.id) row.id = `aud-${++verSeq}`;
          if (table === 'journey_checklist_topics') {
            const idx = store[table].findIndex((r: any) => r.topic_id === row.topic_id);
            if (idx >= 0) store[table][idx] = row;
            else store[table].push(row);
          } else {
            store[table].push(row);
          }
          inserted.push(row);
        }
        return inserted;
      }
      return [];
    }

    const builder: any = {
      select() { return builder; },
      insert(p: any) { st.op = 'insert'; st.payload = p; return builder; },
      update(p: any) { st.op = 'update'; st.payload = p; return builder; },
      delete() { st.op = 'delete'; return builder; },
      eq(c: string, v: any) { st.eqs.push([c, v]); return builder; },
      ilike(c: string, pat: string) { st.ilikes.push([c, String(pat).replace(/%/g, '').toLowerCase()]); return builder; },
      order(col: string, opts: any = {}) { st.orders.push({ col, asc: opts.ascending !== false }); return builder; },
      single() { const r = run(); return Promise.resolve({ data: r[0] ?? null, error: r.length ? null : { message: 'no rows' } }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
      then(resolve: any, reject: any) {
        try { return Promise.resolve({ data: run(), error: null }).then(resolve, reject); }
        catch (e) { return Promise.resolve({ data: null, error: { message: (e as any).message } }).then(resolve, reject); }
      },
    };
    return builder;
  }
  return { __store: store, from } as any;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------
describe('checklist validator', () => {
  it('passes a full valid 90/250 set', () => {
    const r = validateChecklist(fullValidSet());
    expect(r.ok).toBe(true);
    expect(r.summary.sessionCount).toBe(90);
    expect(r.summary.topicCount).toBe(250);
  });

  it('fails when a topic has no voice script', () => {
    const set = fullValidSet();
    set[0].vitanaVoiceScript = '   ';
    const r = validateChecklist(set);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain('missing_voice_script');
  });

  it('fails when a topic has no practice target', () => {
    const set = fullValidSet();
    set[5].guidedPracticeTarget = null;
    const r = validateChecklist(set);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain('missing_practice_target');
  });

  it('fails on wrong per-session card count', () => {
    const set = fullValidSet().filter((t) => !(t.session === 21 && t.position === 3));
    const r = validateChecklist(set);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toEqual(expect.arrayContaining(['topic_count', 'cards_per_session']));
  });

  it('fails on a 5-word label', () => {
    const set = fullValidSet();
    set[1].displayLabel = 'one two three four five';
    const r = validateChecklist(set);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain('label_word_count');
  });

  it('fails when a session>=60 topic is not business-gated', () => {
    const set = fullValidSet();
    const late = set.find((t) => t.session === 80)!;
    late.businessGate = null;
    const r = validateChecklist(set);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain('business_gate');
  });
});

// ---------------------------------------------------------------------------
// Publish + rollback
// ---------------------------------------------------------------------------
describe('checklist publish/rollback', () => {
  it('blocks publish on an invalid draft', async () => {
    const sb = makeFakeSupabase(fullValidSet().slice(0, 100)); // incomplete
    await expect(publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' })).rejects.toBeInstanceOf(
      ChecklistValidationError,
    );
    expect(sb.__store.journey_checklist_versions.length).toBe(0);
  });

  it('publishes a valid draft as the current version + snapshot + audit', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    const { version } = await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z', note: 'first' });
    expect(version.isCurrent).toBe(true);
    expect(version.topicCount).toBe(250);
    expect(version.sessionCount).toBe(90);
    const stored = sb.__store.journey_checklist_versions[0];
    expect(stored.snapshot.length).toBe(250);
    expect(sb.__store.journey_checklist_audit.some((a: any) => a.action === 'publish')).toBe(true);
  });

  it('rollback flips is_current to a prior version', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    const first = (await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' })).version;
    const second = (await publishChecklist(sb, 'admin-1', { now: '2026-06-08T11:00:00Z' })).version;
    expect(sb.__store.journey_checklist_versions.find((v: any) => v.id === second.id).is_current).toBe(true);
    await rollbackChecklist(sb, 'admin-1', first.id);
    expect(sb.__store.journey_checklist_versions.find((v: any) => v.id === first.id).is_current).toBe(true);
    expect(sb.__store.journey_checklist_versions.find((v: any) => v.id === second.id).is_current).toBe(false);
  });

  it('published read returns published snapshot; falls back to draft when none', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    const before = await getPublishedChecklist(sb);
    expect(before.source).toBe('draft_fallback');
    expect(before.topics.length).toBe(250);
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    const after = await getPublishedChecklist(sb);
    expect(after.source).toBe('published');
    expect(after.topics.length).toBe(250);
    // public topics carry no internal fields
    expect(after.topics[0]).not.toHaveProperty('vitanaVoiceScript');
    expect(after.topics[0]).not.toHaveProperty('safetyLevel');
  });
});

// ---------------------------------------------------------------------------
// VTID-03289 — ORB topic seed (voice-inclusive snapshot + server-side pickup)
// ---------------------------------------------------------------------------
describe('ORB topic seed (VTID-03289)', () => {
  it('publish snapshot retains vitanaVoiceScript (so the ORB can narrate)', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    const stored = sb.__store.journey_checklist_versions[0];
    expect(stored.snapshot[0]).toHaveProperty('vitanaVoiceScript');
    expect(stored.snapshot[0].vitanaVoiceScript).toBe('Vitana explains this topic.');
  });

  it('public read still strips vitanaVoiceScript from the widened snapshot', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    const after = await getPublishedChecklist(sb);
    expect(after.source).toBe('published');
    expect(after.topics[0]).not.toHaveProperty('vitanaVoiceScript');
  });

  it('reads the seed from the PUBLISHED snapshot (Publish = go live)', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    const seed = await getOrbTopicSeed(sb, 'T001');
    expect(seed).not.toBeNull();
    expect(seed!.source).toBe('published');
    expect(seed!.vitanaVoiceScript).toBe('Vitana explains this topic.');
    expect(seed!.guidedPracticeTarget).toBe('life_compass');
    expect(seed!.explanation.whatItIs).toBe('x');
  });

  it('falls back to the live draft when nothing is published yet (bootstrap)', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    const seed = await getOrbTopicSeed(sb, 'T001');
    expect(seed).not.toBeNull();
    expect(seed!.source).toBe('draft_fallback');
    expect(seed!.vitanaVoiceScript).toBe('Vitana explains this topic.');
  });

  it('returns null for a topic that is not in the published snapshot', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    expect(await getOrbTopicSeed(sb, 'T999')).toBeNull();
  });

  it('does not peek at the draft once a version is published (authoritative)', async () => {
    // Publish a set, then add a brand-new draft topic that is NOT in the snapshot.
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    sb.__store.journey_checklist_topics.push({
      topic_id: 'T777', curriculum_version: 'v2', session: 1, position: 9,
      chapter_id: 'basics', display_label: 'Unpublished Draft',
      vitana_voice_script: 'SHOULD NOT BE SPOKEN', enabled: true, status: 'draft',
      explanation_what_it_is: null, explanation_user_benefit: null,
      explanation_when_to_use: null, explanation_try_this: null,
      guided_practice_target: 'life_compass',
    });
    // A published version exists → unpublished draft topic must NOT leak to voice.
    expect(await getOrbTopicSeed(sb, 'T777')).toBeNull();
  });
});

describe('ORB topic seed — per-locale voice override (VTID-03309)', () => {
  const seedTranslation = (sb: any, locale: string, script: string) =>
    sb.__store.journey_checklist_translations.push({
      topic_id: 'T001', locale, vitana_voice_script: script, updated_at: '2026-06-13T00:00:00Z',
    });

  it('overlays the German override on the snapshot base for a de session', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    seedTranslation(sb, 'de', 'NEUER deutscher Sprechtext.');
    const seed = await getOrbTopicSeed(sb, 'T001', 'v2', 'de');
    expect(seed!.vitanaVoiceScript).toBe('NEUER deutscher Sprechtext.');
  });

  it('speaks the English script verbatim for an en session (never the German)', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    seedTranslation(sb, 'de', 'Deutscher Text.');
    seedTranslation(sb, 'en', 'English verbatim script.');
    const seed = await getOrbTopicSeed(sb, 'T001', 'v2', 'en');
    expect(seed!.vitanaVoiceScript).toBe('English verbatim script.');
  });

  it('keeps the base snapshot script when the locale has no override', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    seedTranslation(sb, 'en', 'English only.');
    // 'es' has no row → falls back to the authored base, never a mix.
    const seed = await getOrbTopicSeed(sb, 'T001', 'v2', 'es');
    expect(seed!.vitanaVoiceScript).toBe('Vitana explains this topic.');
  });

  it('defaults to the German base when no locale is passed (back-compat)', async () => {
    const sb = makeFakeSupabase(fullValidSet());
    await publishChecklist(sb, 'admin-1', { now: '2026-06-08T10:00:00Z' });
    seedTranslation(sb, 'de', 'Deutsch override.');
    const seed = await getOrbTopicSeed(sb, 'T001');
    expect(seed!.vitanaVoiceScript).toBe('Deutsch override.');
  });

  it('normalizeVoiceLocale maps session languages to a single coherent locale', () => {
    expect(normalizeVoiceLocale('de')).toBe('de');
    expect(normalizeVoiceLocale('de-DE')).toBe('de');
    expect(normalizeVoiceLocale('en')).toBe('en');
    expect(normalizeVoiceLocale('en-US')).toBe('en');
    expect(normalizeVoiceLocale('fr')).toBe('de');
    expect(normalizeVoiceLocale(null)).toBe('de');
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
let mockSupabase: any;
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (h === 'Bearer admin') { req.identity = { user_id: 'admin-1', exafy_admin: true }; return next(); }
    if (h === 'Bearer user') { req.identity = { user_id: 'user-1', exafy_admin: false }; return next(); }
    return res.status(401).json({ ok: false, error: 'unauthenticated' });
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  },
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupabase }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminRouter = require('../src/routes/journey-checklist-admin').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const publicRouter = require('../src/routes/journey-checklist').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/journey-checklist', adminRouter);
  app.use('/api/v1/journey-checklist', publicRouter);
  return app;
}

describe('Checklist HTTP', () => {
  beforeEach(() => { mockSupabase = makeFakeSupabase(fullValidSet()); });

  it('admin topics: 401 without token', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/journey-checklist/topics');
    expect(r.status).toBe(401);
  });

  it('admin topics: 403 for non-admin', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/journey-checklist/topics').set('Authorization', 'Bearer user');
    expect(r.status).toBe(403);
  });

  it('admin topics: 200 + 250 topics for admin', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/journey-checklist/topics').set('Authorization', 'Bearer admin');
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(250);
  });

  it('admin validate: 200 ok=true on full set', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/journey-checklist/validate').set('Authorization', 'Bearer admin');
    expect(r.status).toBe(200);
    expect(r.body.validation.ok).toBe(true);
  });

  it('admin publish: 422 when draft invalid', async () => {
    mockSupabase = makeFakeSupabase(fullValidSet().slice(0, 50));
    const r = await request(makeApp()).post('/api/v1/admin/journey-checklist/publish').set('Authorization', 'Bearer admin').send({});
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('validation_failed');
  });

  it('admin publish: 200 on valid draft', async () => {
    const r = await request(makeApp()).post('/api/v1/admin/journey-checklist/publish').set('Authorization', 'Bearer admin').send({ note: 'go' });
    expect(r.status).toBe(200);
    expect(r.body.version.topicCount).toBe(250);
  });

  it('public read: 401 without token, 200 with', async () => {
    expect((await request(makeApp()).get('/api/v1/journey-checklist')).status).toBe(401);
    const r = await request(makeApp()).get('/api/v1/journey-checklist').set('Authorization', 'Bearer user');
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(250);
  });
});
