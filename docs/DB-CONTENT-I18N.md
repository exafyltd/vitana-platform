# DB-backed content i18n — adding language N+1

**VTID-03515.** How user-visible text that lives in the *database* (not in
`src/i18n/`) gets translated, and why the pipeline is shaped the way it is.

---

## The two surfaces

Most user-visible strings come from `vitana-v1/src/i18n/<locale>/**` and are
covered by that repo's ESLint rules, audit script and parity gate. Two are not:

| Table | Content | Read by | Rows |
|---|---|---|---|
| `nav_catalog_i18n` | Screen `title`, `description`, `when_to_visit` | ORB Navigator (voice intent matching) | ~291 / locale |
| `journey_checklist_translations` | Curriculum topic label, description, 4 explanation fields | My Journey topic popup | ~254 / locale |

Neither is visible to any frontend i18n check, because neither is a file. A
locale can be at 100% catalog parity and still speak German here.

German is the authored source for both and is **never** written to either
table: the Navigator reads `lang='de'` as its own source row, and the checklist
reads German straight off the published snapshot (`fetchChecklistTranslations`
returns `[]` for `de` by design). Seeding a German "translation" would create a
second, divergent copy of the source.

---

## Adding a language

Three steps. There is no fourth.

```sql
-- 1. Register it. This is the whole "add a language" step.
INSERT INTO supported_locales (code, english_name, informal_hint, status)
VALUES ('it', 'Italian', 'Use the informal tu-form. Never Lei.', 'beta');
```

```bash
# 2. Seed. Translates only what is missing or whose source changed.
gh workflow run I18N-DB-SEED.yml -f locale=it -f apply=true
```

```sql
-- 3. When the daily parity check is clean, promote.
UPDATE supported_locales SET status = 'ga' WHERE code = 'it';
```

Locally, the same thing:

```bash
cd services/gateway
npm run i18n:db:seed -- --locale=it            # dry run, writes artifacts only
npm run i18n:db:seed -- --locale=it --apply    # + upsert to the database
npm run i18n:db:check                          # parity gate over every 'ga' locale
```

### Why it is only three steps

Everything that used to need editing per language now reads the registry:

- The DB constraint. `journey_checklist_translations.locale` carried
  `CHECK (locale IN ('en','es','sr'))`, so `fr`/`pt`/`ru`/`pl` rows were
  **rejected by the database** — the seeding failure would have been a
  constraint violation, not a content gap. That CHECK is now a foreign key to
  `supported_locales`.
- The seeding script's own locale list.
- The register hint (du/tú/ti/tu/ty), which is the single highest-leverage line
  in the translator prompt and previously lived in a constant.

---

## How it works

```
supported_locales ──┐
                    ├─► seed-db-i18n.ts ─► data/db-i18n/<surface>/<locale>.json ─► DB
published source ───┘        │                      (committed artifact)
                             └─ translate ONLY units whose source_sha moved
```

**Translations are committed artifacts, and the database is downstream of
them.** This is the design decision most worth keeping. The previous generator
(`scripts/journey/generate-checklist-translations.mjs`) wrote straight to the
DB, which meant nothing was reviewable in a PR, nothing was diffable, and
re-seeding a rebuilt database meant paying for every translation again.
`--from-artifact` replays a locale with zero LLM spend — which is also the
answer to "how do we repopulate Aurora after the migration".

**`source_sha` is what makes the second run cheap.** Each artifact entry records
a hash of the exact source text it was translated from. Only units whose hash
moved are re-translated. Without it the only staleness signal was
`source_version_id`, which cannot see a single topic edited *within* one
published version — and `nav_catalog_i18n` had no staleness mechanism at all.
This is the same blindness that let `es`/`sr` sit two months stale at 100%
"coverage": coverage counts rows, and a stale row is still a row.

The hash is taken over an **ordered** field list. Reordering `SurfaceDef.fields`
invalidates every stored stamp, so treat that list as append-only; the seeder
detects the change and says so rather than reporting the locale as drifted for
no visible reason.

### Adding a third surface

Add a `SurfaceDef` to `services/gateway/src/services/db-i18n/surfaces.ts`:
where the source comes from, which columns are translatable, which may never be
blank, how a row is built. `seed-db-i18n.ts` has no surface-specific branches.

---

## Validation

Four defects were found in shipped `src/i18n/` catalogs during the 8-language
expansion. All four recur on every new language, so the translator rejects them
rather than leaving them for review:

| Defect | Why it is invisible otherwise |
|---|---|
| **Renamed placeholders** (`{date}`→`{datum}`) | Substitution is by name, so the user sees a literal `{datum}`. Repaired positionally when only the names changed; a changed *count* is not mechanically recoverable and fails the unit rather than being guessed at. |
| **Truncated JSON** on long prose | Fails identically on every retry — deterministic, not transient, so retrying is wasted spend. The batch is halved and recursed instead. |
| **Formal register** (Sie/usted/vous/Vi) | Reads perfectly; is simply the wrong brand voice. The hint comes from the registry so each language carries its own rule. |
| **Verbatim source echo** | A model that declines to translate returns the German. That counts as 100% coverage and renders as German. Treated as a failure for that unit. |

A unit is written **whole or not at all** — a half-written row is
indistinguishable from a complete one in every coverage count.

Length is deliberately *not* validated. A rule tuned on one language does not
transfer: the naive French register regex in this same programme produced 39
false positives out of 41, because `rendez-vous` means "appointment" and the
hyphen is a word boundary. Length and idiom belong to the LLM audit pass.

---

## The Aurora target

`DB_I18N_TARGET=supabase|aurora`, default `supabase`. All reads and writes go
through `services/db-i18n/db-i18n-repository.ts`, following the B1 seam pattern
from VTID-03498 — at cutover only that adapter changes, not the pipeline.

**`aurora` is wired but cannot execute yet, and it throws rather than falling
back.** Three independent reasons:

1. The gateway has **no PostgreSQL driver** in its dependency tree. It speaks
   HTTP to PostgREST and never opens a Postgres connection. There is no
   connection string to swap — see `SUPABASE-TO-AURORA-MIGRATION-PLAN.md` §0.
2. Aurora is the **DMS replication target** of Supabase. Writing to it directly
   is the dual-writer hazard that plan records as "Option C — the one to argue
   against", and is why `oasis-projector` was excluded from VTID-03419.
3. That plan's **Phase 0 gate is open**: ~154,000 silently-dropped DMS row
   applies are still unreconciled, so Aurora holds a partial copy of unknown
   quality.

A quiet fallback would mean an operator who set `DB_I18N_TARGET=aurora` believes
the seed landed in Aurora when it landed in Supabase — the same invisible-failure
shape as VTID-03480's `ok:false`. Unblocking is Phase 0 + B1 of the migration
plan, not a change to this pipeline.

---

## Migration verification

The migration was applied against a throwaway PostgreSQL 16 carrying the
pre-migration schema plus a deliberately awkward fixture: a `nl` row in
`nav_catalog_i18n` that is **not** in the release list, standing in for whatever
undocumented locale production may hold.

| # | Property | Result |
|---|---|---|
| 0 | Pre-migration, an `fr` checklist row is rejected | `violates check constraint …_locale_check` — the blocker is real, not theoretical |
| 1 | Legacy `nl` is back-filled as `status='legacy'` | present; the FK validates instead of aborting |
| 2 | `fr`/`pt`/`ru`/`pl` checklist rows insert | `INSERT 0 4` |
| 3 | An unregistered locale is still rejected | `violates foreign key constraint` — the constraint tightened, it did not vanish |
| 4 | `nav_catalog_i18n` accepts a new locale + `source_sha` | `INSERT 0 1` |
| 5 | Legacy rows left `NULL`, not stamped "current" | `en`/`es` → `<NULL>` |
| 6 | Re-applying the migration twice more | clean both times (migrations are applied by hand here — see VTID-03492) |
| 7 | Adding Italian: **one INSERT**, then both surfaces accept `it` | no DDL, no code change |

Row 7 is the whole point: it is the acceptance test for "adding a language is
automated".

---

## Known gap

`supported_locales` and `vitana-v1/src/contexts/LanguageContext.tsx`'s
`languageOptions` must agree, and **nothing currently enforces that**. A locale
that is `ga` in the frontend picker but missing here renders German Navigator
titles inside an otherwise translated UI. The registry table is deliberately
world-readable so the frontend can read it instead of holding a second copy;
making that change is follow-up work.
