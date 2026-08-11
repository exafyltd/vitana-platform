/**
 * VTID-03517 — the Aurora adapter against a REAL PostgreSQL server.
 *
 * WHY THIS IS NOT MOCKED
 *
 * Every interesting thing about this adapter is SQL: a multi-row `unnest`
 * upsert, `ON CONFLICT` update semantics, a two-way LEFT JOIN that prefers the
 * German source row over the English one, and JSONB snapshot extraction. A
 * mocked `pg` client verifies that strings were passed to a fake — it cannot
 * tell you the statement parses, that the conflict target matches the primary
 * key, or that array binding lines the columns up in the right order. Those are
 * exactly the mistakes worth catching, and all of them are invisible to a mock.
 *
 * The Supabase adapter is unit-tested because supabase-js is an HTTP client and
 * its call shape IS the contract. This one is not.
 *
 * HOW TO RUN
 *
 *   AURORA_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:5432/aurora_test?sslmode=disable" \
 *     npx jest aurora-integration
 *
 * Skipped (not failed) when that variable is absent, so a laptop without a
 * local Postgres still gets a green suite. In CI, add a `postgres:16` service
 * container and set the variable.
 */

import { randomUUID } from 'node:crypto';
import {
  createDbI18nRepository,
  type DbI18nRepository,
} from '../../src/services/db-i18n/db-i18n-repository';
import {
  closeAuroraPool,
  __resetAuroraPoolForTests,
  withAuroraClient,
} from '../../src/services/db-i18n/aurora-client';

const URL_ = process.env.AURORA_TEST_DATABASE_URL;
const describeIfDb = URL_ ? describe : describe.skip;

const writeEnv = {
  DB_I18N_TARGET: 'aurora',
  AURORA_DATABASE_URL: URL_ ?? '',
  AURORA_I18N_WRITES: 'enabled',
  AURORA_SSL_INSECURE: 'true',
} as unknown as NodeJS.ProcessEnv;

const readOnlyEnv = { ...writeEnv, AURORA_I18N_WRITES: '' } as NodeJS.ProcessEnv;

describeIfDb('AuroraDbI18nRepository against a live PostgreSQL', () => {
  let repo: DbI18nRepository & { ensureSchema(): Promise<void> };
  const catalogId = randomUUID();
  const versionId = randomUUID();

  beforeAll(async () => {
    __resetAuroraPoolForTests();
    repo = createDbI18nRepository(null, writeEnv) as typeof repo;
    await repo.ensureSchema();

    // Platform tables the SOURCE reads need. `ensureSchema` deliberately does
    // not create these — they are owned by the wider migration, and a stub
    // would produce an empty catalog that looks real.
    await withAuroraClient(async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS public.nav_catalog (
        id uuid PRIMARY KEY, screen_id text NOT NULL, is_active boolean NOT NULL DEFAULT true)`);
      await c.query(`CREATE TABLE IF NOT EXISTS public.journey_checklist_versions (
        id uuid PRIMARY KEY, curriculum_version text NOT NULL,
        is_current boolean NOT NULL DEFAULT false, snapshot jsonb)`);
      await c.query(
        `INSERT INTO public.supported_locales (code, english_name, status)
         VALUES ('de','German','ga'),('en','English','ga'),('fr','French','ga')
         ON CONFLICT (code) DO NOTHING`,
      );
      await c.query(
        `INSERT INTO public.nav_catalog (id, screen_id) VALUES ($1,'PUBLIC.LANDING')
         ON CONFLICT (id) DO NOTHING`,
        [catalogId],
      );
    }, writeEnv);
  }, 60_000);

  afterAll(async () => {
    await closeAuroraPool();
  });

  it('ensureSchema is idempotent', async () => {
    await expect(repo.ensureSchema()).resolves.toBeUndefined();
    await expect(repo.ensureSchema()).resolves.toBeUndefined();
  });

  it('reads the locale registry', async () => {
    const locales = await repo.listSupportedLocales();
    expect(locales.map((l) => l.code)).toEqual(expect.arrayContaining(['de', 'en', 'fr']));
  });

  // VTID-03572. ensureSchema() CREATEs supported_locales and inserts nothing,
  // so on a fresh Aurora resolveLocales() aborts with "supported_locales is
  // empty" and no locale can ever be seeded. This is the step that closes that
  // gap, and it is worth an integration test rather than a unit test because
  // what can go wrong is the SQL: the unnest arity, the ON CONFLICT target
  // matching the primary key, and NULL handling on informal_hint.
  describe('upsertSupportedLocales bootstraps the registry', () => {
    // Resolved lazily. `repo` is assigned in beforeAll, which runs AFTER this
    // describe body is evaluated, so capturing it in a const here binds
    // undefined and every test in the block fails on a null read.
    const up = () =>
      repo as unknown as {
        upsertSupportedLocales(r: Array<Record<string, unknown>>): Promise<number>;
      };

    it('inserts new locales, coalescing an absent hint to the column default', async () => {
      // informal_hint is `text NOT NULL DEFAULT ''`. Passing null through would
      // abort the entire batch on a not-null violation — which this test found,
      // and which no mock could have: the constraint lives in the schema, not
      // in the call.
      const n = await up().upsertSupportedLocales([
        { code: 'zz', english_name: 'Test', informal_hint: null, status: 'draft' },
      ]);
      expect(n).toBe(1);
      const row = (await repo.listSupportedLocales()).find((l) => l.code === 'zz');
      expect(row).toMatchObject({ english_name: 'Test', status: 'draft', informal_hint: '' });
    });

    it('UPDATES on conflict rather than ignoring', async () => {
      // DO NOTHING would leave a stale hint in place forever. That matters
      // because informal_hint is fed verbatim into the translation prompt and
      // status decides which locales get selected — a stale row here produces
      // wrong translations silently instead of an error, so re-running must
      // converge on upstream rather than preserve whatever landed first.
      await up().upsertSupportedLocales([
        { code: 'zz', english_name: 'Test Renamed', informal_hint: 'be informal', status: 'ga' },
      ]);
      const row = (await repo.listSupportedLocales()).find((l) => l.code === 'zz');
      expect(row).toMatchObject({
        english_name: 'Test Renamed',
        informal_hint: 'be informal',
        status: 'ga',
      });
    });

    it('binds a multi-row batch column-for-column', async () => {
      // The unnest form fails silently-wrong if the arrays are transposed:
      // every row would still insert, just with the fields swapped. One row
      // cannot detect that; two rows with distinguishable values can.
      await up().upsertSupportedLocales([
        { code: 'zy', english_name: 'Alpha', informal_hint: 'hint-a', status: 'beta' },
        { code: 'zx', english_name: 'Beta', informal_hint: 'hint-b', status: 'draft' },
      ]);
      const all = await repo.listSupportedLocales();
      expect(all.find((l) => l.code === 'zy')).toMatchObject({
        english_name: 'Alpha', informal_hint: 'hint-a', status: 'beta',
      });
      expect(all.find((l) => l.code === 'zx')).toMatchObject({
        english_name: 'Beta', informal_hint: 'hint-b', status: 'draft',
      });
    });

    it('is blocked without the write flag, like every other write', async () => {
      const ro = createDbI18nRepository(null, readOnlyEnv) as unknown as {
        upsertSupportedLocales(r: Array<Record<string, unknown>>): Promise<number>;
      };
      await expect(
        ro.upsertSupportedLocales([
          { code: 'zw', english_name: 'Nope', informal_hint: null, status: 'draft' },
        ]),
      ).rejects.toThrow();
    });

    it('writes nothing for an empty batch', async () => {
      const before = (await repo.listSupportedLocales()).length;
      await expect(up().upsertSupportedLocales([])).resolves.toBe(0);
      expect((await repo.listSupportedLocales()).length).toBe(before);
    });
  });

  it('upserts nav rows and is idempotent on the natural key', async () => {
    const rows = [
      {
        catalog_id: catalogId, lang: 'fr', title: 'Accueil',
        description: 'La page d entree', when_to_visit: 'retour au debut',
        source_sha: 'sha-v1',
      },
    ];
    expect(await repo.upsertNavCatalogI18n(rows)).toBe(1);
    expect(await repo.upsertNavCatalogI18n(rows)).toBe(1);

    const cov = await repo.navCatalogCoverage('fr');
    // Two identical upserts must leave ONE row, not two — proof the conflict
    // target actually matches the primary key.
    expect(cov.filter((c) => c.key === catalogId)).toHaveLength(1);
    expect(cov.find((c) => c.key === catalogId)?.source_sha).toBe('sha-v1');
  });

  it('ON CONFLICT updates content and re-stamps, rather than ignoring', async () => {
    await repo.upsertNavCatalogI18n([
      {
        catalog_id: catalogId, lang: 'fr', title: 'Accueil v2',
        description: 'd2', when_to_visit: 'w2', source_sha: 'sha-v2',
      },
    ]);
    const cov = await repo.navCatalogCoverage('fr');
    expect(cov.find((c) => c.key === catalogId)?.source_sha).toBe('sha-v2');
    const [row] = await withAuroraClient(
      async (c) =>
        (await c.query('SELECT title FROM public.nav_catalog_i18n WHERE catalog_id=$1 AND lang=$2',
          [catalogId, 'fr'])).rows,
      writeEnv,
    );
    expect((row as { title: string }).title).toBe('Accueil v2');
  });

  it('binds a multi-row batch column-for-column', async () => {
    // A transposed array binding still inserts N rows and still "succeeds" —
    // the only way to catch it is to read the values back per key.
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await withAuroraClient(async (c) => {
      for (const [i, id] of ids.entries()) {
        await c.query(`INSERT INTO public.nav_catalog (id, screen_id) VALUES ($1,$2)`, [id, `S${i}`]);
      }
    }, writeEnv);
    await repo.upsertNavCatalogI18n(
      ids.map((id, i) => ({
        catalog_id: id, lang: 'fr', title: `T${i}`, description: `D${i}`,
        when_to_visit: `W${i}`, source_sha: `SHA${i}`,
      })),
    );
    const rows = await withAuroraClient(
      async (c) =>
        (await c.query(
          `SELECT catalog_id::text, title, description, when_to_visit, source_sha
             FROM public.nav_catalog_i18n WHERE catalog_id = ANY($1::uuid[]) ORDER BY title`,
          [ids],
        )).rows as { catalog_id: string; title: string; description: string; when_to_visit: string; source_sha: string }[],
      writeEnv,
    );
    expect(rows).toHaveLength(3);
    rows.forEach((r, i) => {
      expect(r.title).toBe(`T${i}`);
      expect(r.description).toBe(`D${i}`);
      expect(r.when_to_visit).toBe(`W${i}`);
      expect(r.source_sha).toBe(`SHA${i}`);
      expect(r.catalog_id).toBe(ids[i]);
    });
  });

  it('upserts checklist rows with all six fields and both provenance columns', async () => {
    await repo.upsertChecklistTranslations([
      {
        topic_id: 'T1', locale: 'fr',
        display_label: 'Ta premiere semaine',
        short_description: 'sd',
        explanation_what_it_is: 'a',
        explanation_user_benefit: 'b',
        explanation_when_to_use: 'c',
        explanation_try_this: 'd',
        source_version_id: versionId,
        source_sha: 'chk-sha',
      },
    ]);
    const [row] = await withAuroraClient(
      async (c) =>
        (await c.query(
          `SELECT display_label, short_description, explanation_what_it_is,
                  explanation_user_benefit, explanation_when_to_use, explanation_try_this,
                  source_version_id::text, source_sha
             FROM public.journey_checklist_translations WHERE topic_id='T1' AND locale='fr'`,
        )).rows as Record<string, string>[],
      writeEnv,
    );
    expect(row).toMatchObject({
      display_label: 'Ta premiere semaine', short_description: 'sd',
      explanation_what_it_is: 'a', explanation_user_benefit: 'b',
      explanation_when_to_use: 'c', explanation_try_this: 'd',
      source_version_id: versionId, source_sha: 'chk-sha',
    });
  });

  it('preserves NULL for an untranslated optional field', async () => {
    await repo.upsertChecklistTranslations([
      {
        topic_id: 'T2', locale: 'fr', display_label: 'L', short_description: null,
        explanation_what_it_is: null, explanation_user_benefit: null,
        explanation_when_to_use: null, explanation_try_this: null,
      },
    ]);
    const [row] = await withAuroraClient(
      async (c) =>
        (await c.query(
          `SELECT short_description, source_sha FROM public.journey_checklist_translations
            WHERE topic_id='T2' AND locale='fr'`,
        )).rows as { short_description: string | null; source_sha: string | null }[],
      writeEnv,
    );
    expect(row.short_description).toBeNull();
    expect(row.source_sha).toBeNull();
  });

  describe('navCatalogSource prefers German over English', () => {
    it('uses the de row when both exist', async () => {
      await repo.upsertNavCatalogI18n([
        { catalog_id: catalogId, lang: 'de', title: 'Startseite', description: 'DE-d', when_to_visit: 'DE-w' },
        { catalog_id: catalogId, lang: 'en', title: 'Landing', description: 'EN-d', when_to_visit: 'EN-w' },
      ]);
      const units = await repo.navCatalogSource();
      const u = units.find((x) => x.key === catalogId);
      expect(u?.fields.title).toBe('Startseite');
      expect(u?.meta?.source_lang).toBe('de');
    });

    it('falls back to en when there is no de row, and says so', async () => {
      const enOnly = randomUUID();
      await withAuroraClient(
        async (c) => { await c.query(`INSERT INTO public.nav_catalog (id, screen_id) VALUES ($1,'EN.ONLY')`, [enOnly]); },
        writeEnv,
      );
      await repo.upsertNavCatalogI18n([
        { catalog_id: enOnly, lang: 'en', title: 'English Only', description: '', when_to_visit: '' },
      ]);
      const u = (await repo.navCatalogSource()).find((x) => x.key === enOnly);
      expect(u?.fields.title).toBe('English Only');
      // Reported, not hidden: translating from an English pivot is a quality
      // caveat the audit needs to be able to count.
      expect(u?.meta?.source_lang).toBe('en');
    });

    it('omits an entry with no source text at all', async () => {
      const bare = randomUUID();
      await withAuroraClient(
        async (c) => { await c.query(`INSERT INTO public.nav_catalog (id, screen_id) VALUES ($1,'BARE')`, [bare]); },
        writeEnv,
      );
      expect((await repo.navCatalogSource()).find((x) => x.key === bare)).toBeUndefined();
    });

    it('excludes inactive catalog entries', async () => {
      const dead = randomUUID();
      await withAuroraClient(async (c) => {
        await c.query(`INSERT INTO public.nav_catalog (id, screen_id, is_active) VALUES ($1,'DEAD',false)`, [dead]);
      }, writeEnv);
      await repo.upsertNavCatalogI18n([
        { catalog_id: dead, lang: 'de', title: 'Tot', description: '', when_to_visit: '' },
      ]);
      expect((await repo.navCatalogSource()).find((x) => x.key === dead)).toBeUndefined();
    });
  });

  describe('checklistSource reads the published snapshot', () => {
    beforeAll(async () => {
      await withAuroraClient(async (c) => {
        await c.query(
          `INSERT INTO public.journey_checklist_versions (id, curriculum_version, is_current, snapshot)
           VALUES ($1,'v2',true,$2::jsonb) ON CONFLICT (id) DO NOTHING`,
          [versionId, JSON.stringify([
            {
              topicId: 'T1', displayLabel: 'Deine erste Woche', shortDescription: 'kurz',
              explanation: { whatItIs: 'w', userBenefit: 'u', whenToUse: 'wu', tryThis: 'tt' },
            },
            { topicId: 'T2', displayLabel: 'Zweite' },
            { notATopic: true },
          ])],
        );
      }, writeEnv);
    });

    it('maps camelCase snapshot fields to the DB column names', async () => {
      const units = await repo.checklistSource('v2');
      const t1 = units.find((u) => u.key === 'T1');
      expect(t1?.fields).toEqual({
        display_label: 'Deine erste Woche', short_description: 'kurz',
        explanation_what_it_is: 'w', explanation_user_benefit: 'u',
        explanation_when_to_use: 'wu', explanation_try_this: 'tt',
      });
      expect(t1?.meta?.source_version_id).toBe(versionId);
    });

    it('defaults absent snapshot fields to empty rather than undefined', async () => {
      const t2 = (await repo.checklistSource('v2')).find((u) => u.key === 'T2');
      // undefined would hash differently from '' and churn the whole locale.
      expect(t2?.fields.short_description).toBe('');
    });

    it('skips malformed snapshot entries instead of throwing', async () => {
      expect((await repo.checklistSource('v2')).map((u) => u.key).sort()).toEqual(['T1', 'T2']);
    });

    it('returns [] for a curriculum version with no current publication', async () => {
      expect(await repo.checklistSource('v99')).toEqual([]);
    });
  });

  it('BLOCKS writes when AURORA_I18N_WRITES is unset, even against a reachable DB', async () => {
    // The whole point of splitting the flags: connectivity is not consent.
    __resetAuroraPoolForTests();
    const ro = createDbI18nRepository(null, readOnlyEnv);
    await expect(
      ro.upsertNavCatalogI18n([
        { catalog_id: catalogId, lang: 'fr', title: 'nope', description: '', when_to_visit: '' },
      ]),
    ).rejects.toThrow(/AURORA_I18N_WRITES is not 'enabled'/);

    // ...and the read path still works on the same connection settings.
    await expect(ro.navCatalogCoverage('fr')).resolves.toEqual(expect.any(Array));
    __resetAuroraPoolForTests();
  });

  it('surfaces a database error as DbI18nRepositoryError, not an empty result', async () => {
    __resetAuroraPoolForTests();
    const broken = createDbI18nRepository(null, {
      ...writeEnv,
      AURORA_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nope',
    } as NodeJS.ProcessEnv);
    await expect(broken.listSupportedLocales()).rejects.toThrow();
    __resetAuroraPoolForTests();
  }, 30_000);
});
