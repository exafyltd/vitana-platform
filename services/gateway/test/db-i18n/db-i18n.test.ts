/**
 * VTID-03515 — tests for the DB-content i18n seeding pipeline.
 *
 * The bias here is toward pinning the properties that failed silently in the
 * frontend catalog work: a stale row that counts as coverage, a renamed
 * placeholder, an untranslated passthrough, and a fallback that hides which
 * database was actually written.
 */

import {
  AURORA_READINESS_NOTE,
  createDbI18nRepository,
  resolveDbI18nTarget,
  DEFAULT_DB_I18N_TARGET,
} from '../../src/services/db-i18n/db-i18n-repository';
import {
  assertAuroraWritesAllowed,
  resolveAuroraConfig,
} from '../../src/services/db-i18n/aurora-client';
import { getSurface, sourceSha, SOURCE_LOCALE, SURFACES } from '../../src/services/db-i18n/surfaces';
import {
  placeholders,
  repairPlaceholders,
  translateUnits,
  validateUnit,
  type TranslateUnit,
} from '../../src/services/db-i18n/translator';

describe('target selection', () => {
  // VTID-03564: the default is AURORA now — owner decision, Aurora is the
  // intended primary for staging and production. Asserted against the exported
  // constant rather than a literal, so the two cannot drift apart silently.
  it('defaults to the declared default (aurora) when unset or empty', () => {
    expect(DEFAULT_DB_I18N_TARGET).toBe('aurora');
    expect(resolveDbI18nTarget({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DB_I18N_TARGET);
    expect(resolveDbI18nTarget({ DB_I18N_TARGET: '' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DB_I18N_TARGET,
    );
  });

  it('still selects supabase when asked for explicitly', () => {
    expect(resolveDbI18nTarget({ DB_I18N_TARGET: 'supabase' } as NodeJS.ProcessEnv)).toBe(
      'supabase',
    );
  });

  it('selects aurora on the exact value, case/space tolerant', () => {
    expect(resolveDbI18nTarget({ DB_I18N_TARGET: 'aurora' } as NodeJS.ProcessEnv)).toBe('aurora');
    expect(resolveDbI18nTarget({ DB_I18N_TARGET: ' AURORA ' } as NodeJS.ProcessEnv)).toBe('aurora');
  });

  it('falls back to the default on an unrecognised value rather than guessing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDbI18nTarget({ DB_I18N_TARGET: 'postgres' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DB_I18N_TARGET,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('aurora adapter (VTID-03517)', () => {
  const auroraEnv = (extra: Record<string, string> = {}) =>
    ({ DB_I18N_TARGET: 'aurora', ...extra }) as NodeJS.ProcessEnv;

  it('is constructible without a Supabase client', () => {
    expect(createDbI18nRepository(null, auroraEnv()).target).toBe('aurora');
  });

  it('reports a missing connection string as config, not as an empty result', async () => {
    const repo = createDbI18nRepository(null, auroraEnv());
    // The dangerous alternative is returning [] — the caller would read that as
    // "Aurora has no rows" and happily proceed to overwrite or report parity.
    await expect(repo.listSupportedLocales()).rejects.toThrow(/AURORA_DATABASE_URL is not set/);
  });

  it('rejects a connection string that is not a postgres URL', () => {
    expect(() => resolveAuroraConfig(auroraEnv({ AURORA_DATABASE_URL: 'https://db.example' }))).toThrow(
      /must be a postgres/i,
    );
  });

  it('redacts the password when describing the target', () => {
    const cfg = resolveAuroraConfig(
      auroraEnv({ AURORA_DATABASE_URL: 'postgres://u:hunter2@host:5432/db' }),
    );
    expect(cfg.describe).not.toContain('hunter2');
    expect(cfg.describe).toContain('host');
  });

  /**
   * The central safety property of this VTID. Being able to REACH Aurora is
   * not permission to write to it: these tables are DMS replication targets,
   * so a second writer is the "Option C" hazard. Connectivity and write
   * permission are therefore separate flags, and the write flag defaults off
   * even when Aurora is fully configured.
   */
  describe('writes are gated separately from connectivity', () => {
    const configured = auroraEnv({ AURORA_DATABASE_URL: 'postgres://u:p@h:5432/d' });

    it.each([
      ['upsertNavCatalogI18n', (r: ReturnType<typeof createDbI18nRepository>) =>
        r.upsertNavCatalogI18n([
          { catalog_id: 'c', lang: 'fr', title: 't', description: '', when_to_visit: '' },
        ])],
      ['upsertChecklistTranslations', (r: ReturnType<typeof createDbI18nRepository>) =>
        r.upsertChecklistTranslations([
          {
            topic_id: 't', locale: 'fr', display_label: 'x', short_description: null,
            explanation_what_it_is: null, explanation_user_benefit: null,
            explanation_when_to_use: null, explanation_try_this: null,
          },
        ])],
    ])('%s refuses without AURORA_I18N_WRITES', async (_n, call) => {
      await expect(call(createDbI18nRepository(null, configured))).rejects.toThrow(
        /AURORA_I18N_WRITES is not 'enabled'/,
      );
    });

    it('explains WHY, so the flag is not set reflexively', async () => {
      const repo = createDbI18nRepository(null, configured);
      // The text is hard-wrapped, so match across the line break.
      await expect(repo.upsertNavCatalogI18n([])).rejects.toThrow(/DMS\s+replication targets/);
      await expect(repo.upsertNavCatalogI18n([])).rejects.toThrow(/Option C/);
    });

    it('does not gate reads behind the write flag', () => {
      // Reads must work unflagged — reconciling these tables is a slice of the
      // Phase 0 exit criteria, and gating it would make the gate unmeasurable.
      expect(() => assertAuroraWritesAllowed('x', auroraEnv({ AURORA_I18N_WRITES: 'enabled' }))).not.toThrow();
    });
  });

  it('never silently falls back to supabase', async () => {
    // A fallback would resolve rather than reject, and the caller would believe
    // Aurora was written. This is the VTID-03480 failure shape.
    const repo = createDbI18nRepository(null, auroraEnv());
    await expect(repo.upsertNavCatalogI18n([])).rejects.toBeInstanceOf(Error);
  });

  it('keeps naming the remaining risk rather than decaying to "not implemented"', () => {
    expect(AURORA_READINESS_NOTE).toMatch(/DMS replication TARGET/i);
    expect(AURORA_READINESS_NOTE).toMatch(/154,000|154000/);
    expect(AURORA_READINESS_NOTE).toMatch(/AURORA_I18N_WRITES=enabled/);
  });
});

describe('aurora TLS resolution', () => {
  it('defaults to verifying certificates', () => {
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://u:p@h:5432/d',
    } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('only disables verification on an explicit opt-in, and warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveAuroraConfig({
      AURORA_DATABASE_URL: 'postgres://u:p@h:5432/d',
      AURORA_SSL_INSECURE: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/verification is DISABLED/));
    warn.mockRestore();
  });

  describe('sslmode=disable is a loopback-only escape hatch', () => {
    it.each(['127.0.0.1', 'localhost', '[::1]'])('permits plaintext to %s', (host) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const cfg = resolveAuroraConfig({
        AURORA_DATABASE_URL: `postgres://u@${host}:5432/d?sslmode=disable`,
      } as NodeJS.ProcessEnv);
      expect(cfg.ssl).toBe(false);
      warn.mockRestore();
    });

    it('REFUSES plaintext to a remote host', () => {
      // Without the host check this flag would be a one-line way to send
      // production credentials across a network in the clear.
      expect(() =>
        resolveAuroraConfig({
          AURORA_DATABASE_URL:
            'postgres://u:p@vitana-aurora-prod.eu-central-1.rds.amazonaws.com:5432/d?sslmode=disable',
        } as NodeJS.ProcessEnv),
      ).toThrow(/only permitted for loopback hosts/);
    });

    it('still requires TLS for a loopback host without the flag', () => {
      const cfg = resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://u@127.0.0.1:5432/d',
      } as NodeJS.ProcessEnv);
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    });
  });

  it('fails loudly when the CA bundle path is set but absent', () => {
    // Silently continuing here would downgrade to an unverified connection
    // while the operator believes the bundle is in use.
    expect(() =>
      resolveAuroraConfig({
        AURORA_DATABASE_URL: 'postgres://u:p@h:5432/d',
        AURORA_CA_BUNDLE_PATH: '/nonexistent/rds-ca.pem',
      } as NodeJS.ProcessEnv),
    ).toThrow(/no such file exists/);
  });
});

describe('supabase target requires a client', () => {
  it('throws a specific error rather than a null dereference', () => {
    // VTID-03564: must ask for supabase EXPLICITLY now. An empty env resolves
    // to the aurora default, so `{}` would exercise the Aurora branch and this
    // assertion would pass or fail for entirely the wrong reason.
    expect(() =>
      createDbI18nRepository(null, { DB_I18N_TARGET: 'supabase' } as NodeJS.ProcessEnv),
    ).toThrow(/no Supabase client was supplied/);
  });
});

describe('sourceSha', () => {
  const order = ['title', 'description'] as const;

  it('is stable regardless of object key insertion order', () => {
    const a = sourceSha({ title: 'Start', description: 'Los' }, order);
    const b = sourceSha({ description: 'Los', title: 'Start' }, order);
    expect(a).toBe(b);
  });

  it('changes when any source field changes', () => {
    const base = sourceSha({ title: 'Start', description: 'Los' }, order);
    expect(sourceSha({ title: 'Start!', description: 'Los' }, order)).not.toBe(base);
    expect(sourceSha({ title: 'Start', description: 'Los!' }, order)).not.toBe(base);
  });

  /**
   * The separator matters. Without one, {title:'ab', description:'c'} and
   * {title:'a', description:'bc'} hash identically — a real edit that moves a
   * word between fields would report as unchanged.
   */
  it('does not collide when content shifts between fields', () => {
    expect(sourceSha({ title: 'ab', description: 'c' }, order)).not.toBe(
      sourceSha({ title: 'a', description: 'bc' }, order),
    );
  });

  it('distinguishes an empty field from a missing one consistently', () => {
    expect(sourceSha({ title: 'x', description: '' }, order)).toBe(sourceSha({ title: 'x' }, order));
  });
});

describe('placeholder handling', () => {
  it('matches non-ASCII token names — the case \\w+ misses', () => {
    expect(placeholders('{datum} · {početak}')).toEqual(['datum', 'početak']);
  });

  it('does not swallow an embedded JSON example as one token', () => {
    expect(placeholders('e.g. { "a": 1 } and {count}')).toEqual(['count']);
  });

  it('passes through an already-correct translation', () => {
    expect(repairPlaceholders('{used} of {limit}', '{used} von {limit}')).toBe('{used} von {limit}');
  });

  it('repairs renamed tokens positionally', () => {
    expect(repairPlaceholders('{date} · {start}–{end}', '{datum} · {početak}–{kraj}')).toBe(
      '{date} · {start}–{end}',
    );
  });

  it('refuses to guess when the token COUNT changed', () => {
    // The model duplicated a token for number agreement. No positional remap
    // can undo that, so guessing would ship a plausible but wrong string.
    expect(repairPlaceholders('{length} ticket{value1}', '{length} bilhete{value1}{value1}')).toBeNull();
    expect(repairPlaceholders('{a} {b}', 'nur {a}')).toBeNull();
  });
});

describe('validateUnit', () => {
  const unit: TranslateUnit = {
    key: 'SCREEN.X',
    fields: {
      title: 'Meine Reise',
      description: 'Dein persönlicher Fortschritt in der Community.',
      when_to_visit: '',
    },
  };
  const required = ['title'] as const;

  it('accepts a well-formed translation', () => {
    const v = validateUnit(
      unit,
      { title: 'My Journey', description: 'Your personal progress in the community.', when_to_visit: '' },
      required,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.fields.title).toBe('My Journey');
  });

  it('keeps an empty source field empty rather than inventing content', () => {
    const v = validateUnit(
      unit,
      { title: 'My Journey', description: 'Your progress.', when_to_visit: 'invented text' },
      required,
    );
    expect(v.ok).toBe(true);
    // An invented value here would never be reviewable — no German original exists.
    if (v.ok) expect(v.fields.when_to_visit).toBe('');
  });

  it('rejects the unit when a REQUIRED field is blank', () => {
    const v = validateUnit(unit, { title: '', description: 'Your progress.' }, required);
    expect(v).toEqual({ ok: false, reason: 'required field title was empty' });
  });

  it('blanks an OPTIONAL missing field so the read path falls back to German', () => {
    const v = validateUnit(unit, { title: 'My Journey' }, required);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.fields.description).toBe('');
  });

  it('rejects a unit missing entirely from the response', () => {
    expect(validateUnit(unit, undefined, required)).toEqual({
      ok: false,
      reason: 'missing from response',
    });
  });

  /**
   * The silent-passthrough case: a model that declines to translate echoes the
   * source. That counts as coverage everywhere and renders as German.
   */
  it('rejects a substantive field echoed back verbatim', () => {
    const v = validateUnit(
      unit,
      { title: 'Meine Reise', description: 'Your progress.' },
      required,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/identical to the German source/);
  });

  it('allows a SHORT unchanged string — proper nouns survive translation', () => {
    const brand: TranslateUnit = { key: 'K', fields: { title: 'ORB' } };
    const v = validateUnit(brand, { title: 'ORB' }, required);
    expect(v.ok).toBe(true);
  });

  it('rejects a unit whose placeholder count changed', () => {
    const ph: TranslateUnit = { key: 'K', fields: { title: '{used} von {limit} Einheiten' } };
    const v = validateUnit(ph, { title: 'nur {used} Einheiten' }, required);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/placeholder count changed/);
  });

  it('repairs a renamed placeholder rather than failing the unit', () => {
    const ph: TranslateUnit = { key: 'K', fields: { title: '{used} von {limit} Einheiten' } };
    const v = validateUnit(ph, { title: '{usado} de {limite} unidades' }, required);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.fields.title).toBe('{used} de {limit} unidades');
  });
});

describe('translateUnits batch splitting', () => {
  const opts = (fetchImpl: typeof fetch) => ({
    apiKey: 'k',
    languageName: 'French',
    informalHint: 'tu',
    brief: 'b',
    fetchImpl,
  });

  const geminiText = (text: string) =>
    ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    }) as unknown as Response;
  const geminiOk = (payload: unknown) => geminiText(JSON.stringify(payload));

  const units: TranslateUnit[] = Array.from({ length: 4 }, (_, i) => ({
    key: `K${i}`,
    fields: { title: `Quelle Nummer ${i}` },
  }));

  /**
   * The truncation bug: a big batch fails to parse EVERY time, identically.
   * Retrying is wasted spend; halving is the only recovery.
   */
  it('splits a batch that fails to parse, down to units that succeed', async () => {
    const seen: number[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const prompt = body.contents[0].parts[0].text as string;
      const count = (prompt.match(/"K\d"/g) ?? []).length;
      seen.push(count);
      if (count > 2) {
        return geminiText("{\"K0\": {");
      }
      const payload: Record<string, unknown> = {};
      for (const m of prompt.matchAll(/"(K\d)"/g)) payload[m[1]] = { title: `Source num ${m[1]}` };
      return geminiOk(payload);
    }) as unknown as typeof fetch;

    const res = await translateUnits(units, opts(fetchImpl), ['title'], 4);
    expect(seen[0]).toBe(4); // first attempt took the whole batch
    expect(Math.max(...seen.slice(1))).toBeLessThanOrEqual(2); // then halved
    expect(res.translated.size).toBe(4);
    expect(res.failures).toHaveLength(0);
  });

  it('reports a genuine per-unit failure once the batch is a single unit', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }) as unknown as Response) as unknown as typeof fetch;

    const res = await translateUnits(units.slice(0, 2), opts(fetchImpl), ['title'], 2);
    expect(res.translated.size).toBe(0);
    expect(res.failures.map((f) => f.key).sort()).toEqual(['K0', 'K1']);
  });

  it('surfaces an HTTP error as a failure rather than an empty success', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, text: async () => 'rate limited' }) as unknown as Response) as unknown as typeof fetch;
    const res = await translateUnits(units.slice(0, 1), opts(fetchImpl), ['title'], 1);
    expect(res.failures[0].reason).toMatch(/429/);
  });
});

describe('surface registry', () => {
  it('exposes both content surfaces', () => {
    expect(SURFACES.map((s) => s.id).sort()).toEqual(['journey-checklist', 'nav-catalog']);
  });

  it('rejects an unknown surface by name, listing the known ones', () => {
    expect(() => getSurface('nope')).toThrow(/Known: /);
  });

  it('never treats German as a translation target', () => {
    expect(SOURCE_LOCALE).toBe('de');
  });

  it('builds a nav_catalog_i18n row with the natural key and stamp', () => {
    const row = getSurface('nav-catalog').buildRow({
      unit: { key: 'cat-1', fields: {} },
      locale: 'fr',
      translated: { title: 'Mon parcours', description: 'd', when_to_visit: 'w' },
      sha: 'abc123',
    }) as Record<string, unknown>;
    expect(row).toMatchObject({ catalog_id: 'cat-1', lang: 'fr', title: 'Mon parcours', source_sha: 'abc123' });
  });

  /**
   * The checklist read path treats '' and null identically (per-field fallback
   * to German), but null is the honest encoding of "not translated" and keeps
   * the column's own semantics usable in SQL.
   */
  it('writes NULL rather than empty string for untranslated checklist fields', () => {
    const row = getSurface('journey-checklist').buildRow({
      unit: { key: 't1', fields: {}, meta: { source_version_id: 'v-1' } },
      locale: 'pt',
      translated: { display_label: 'Etiqueta', short_description: '' },
      sha: 'deadbeef',
    }) as Record<string, unknown>;
    expect(row.display_label).toBe('Etiqueta');
    expect(row.short_description).toBeNull();
    expect(row.source_version_id).toBe('v-1');
    expect(row.source_sha).toBe('deadbeef');
  });

  it('requires a non-empty label on both surfaces', () => {
    expect(getSurface('nav-catalog').requiredFields).toContain('title');
    expect(getSurface('journey-checklist').requiredFields).toContain('display_label');
  });
});
