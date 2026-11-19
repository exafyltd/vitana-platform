# VTID-05803 — Aurora staging schema acceptance: final package (owner)

Scope: the additive schema correction of `vitana-aurora-staging` `public` and its verification by the pinned
comparator `scripts/aws/staging-acceptance/k5.py`. This package does not change the comparator and does not claim a
pass. No production was touched.

## Verdict

The six missing preserved-seed tables and their dependent objects are restored and VERIFIED. The comparator was re-run
after the correction and still **REJECTS** (apply job exits non-zero, container 17) because it returns 0 only when
A07 **and** A08 **and** A09 all pass, and they do not. This is expected: the schema correction is additive only, while
the remainder is non-additive, platform-bound, or data.

| Suite | Before | After | State |
|---|---|---|---|
| A07 object parity | 401 unexplained | **142 unexplained** | partial — six-table set fully resolved; 142 residual accounted below |
| A08 grants/policies/RLS/exts | ~2/7 | **6/7 pass** | extension, policy, rls, table_grant, column_grant, sequence_grant pass; only function_grant differs |
| A09 staging invariants | FAIL | FAIL (3) | holding-schema `vtid05803_preexisting` rows + a sequence value — the DMS data step |

The 142 remaining A07 differences reconcile exactly: **121** function fingerprints + **11** platform exceptions +
**7** PUBLIC-EXECUTE grants + **3** duplicate-sequence artifacts = 142. Each is characterized below.

---

## 1. Security of the seven functions carrying a PUBLIC EXECUTE grant

These seven are the newly-created `plan_sparring`/`vtid` functions. Postgres grants `EXECUTE` to `PUBLIC` by default on
creation; source had revoked it. The correction already applied the source's role-scoped grants (so the role grants are
correct); the only extra is the default `PUBLIC` grant. Properties read from the applied definitions
(= `pg_get_functiondef` from source) and the source A07 fingerprint:

| function | SECURITY DEFINER | search_path (pinned) | sensitive-schema access | correct role grants present |
|---|---|---|---|---|
| `_plan_sparring_gate_eval(text,jsonb,text)` | yes | `public, pg_temp` | none | service_role, vitana_governance_owner |
| `_plan_sparring_mode()` | yes | `public, pg_temp` | none | service_role, vitana_governance_owner |
| `allocate_global_vtid(text,text,text,uuid,text)` | yes | `public, pg_temp` | none | service_role |
| `plan_sparring_append_round(uuid,jsonb,integer)` | yes | `public, pg_temp` | none | service_role |
| `plan_sparring_check()` | no (invoker) | `public, pg_temp` | none | service_role |
| `plan_sparring_trigger_status()` | yes | `public, pg_catalog` | none | service_role |
| `submit_plan_sparring_record(...)` | yes | `public, pg_temp` | none | service_role |

**Finding.** Six of seven are SECURITY DEFINER, but every one pins `search_path` (no search-path-injection vector) and
**none** reference any sensitive schema (`auth`, `vault`, `pgsodium`, `extensions`, `storage`, `net`, `pgmq`, `cron`) —
scanned with a superset of the comparator's sensitive-schema pattern (its six — `net|vault|pgsodium|extensions|auth|storage`
— plus `pgmq`/`cron`). They operate only on the public `plan_sparring_*` / `vtid_ledger`
tables. The risk from the default PUBLIC grant is therefore bounded, but it is broader than source (any role may call a
definer-rights function). **Recommended owner action:** `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC` on these seven to
match source's least-privilege posture. This is a REVOKE, so the additive correction did not perform it.

## 2. The 121 "changed function" fingerprints are normalization artifacts

The comparator fingerprints each function as explicit attributes plus `src = md5(prosrc)` (raw body text) and
`def = md5(pg_get_functiondef)` (A07-object-parity-suite.sql). Evidence
(`outputs/function-fingerprint-evidence.tsv`, all 121 rows):

- **121 / 121** — every non-body attribute is byte-identical source↔staging: `kind`, `lang`, `returns`, `volatility`,
  `secdef`, `strict`, `leakproof`, `parallel`, and `config` (search_path). No signature, return type, security, or
  volatility differs.
- **119 / 121** — staging's `src = md5(prosrc)` equals md5 of the body text extracted from the exact definition the
  correction applied (the body portion of `pg_get_functiondef(source)`). So staging stores the source function's own
  canonical body.
- Both body hashes differ for all 121 — `src` (raw `prosrc`) **and** `def` (`md5(pg_get_functiondef)`), the two body
  hashes the comparator records. Both trace to one cause: source stores a **raw** `prosrc`, while the migration and any
  `pg_get_functiondef`-based re-apply store the **normalized** body. Staging therefore holds the normalized form, so
  both its raw-body hash (`src`) and its re-rendered `pg_get_functiondef` hash (`def`) differ from source's. On the
  worked example the delta is a leading newline; the general mechanism is `pg_get_functiondef` normalization —
  demonstrated for `src` by the 119/121 md5 match above, and characterized (not independently hash-proven) for `def`.
  No non-body attribute differs, so this is a representation difference, not logic; a `CREATE OR REPLACE` that uses the
  canonical form cannot converge the raw-`prosrc` hash the comparator correctly compares.

Worked example — `agents_registry_set_updated_at()` (trigger, plpgsql, `config=-`):
- applied body (from source) = `"\nBEGIN NEW.updated_at := NOW(); RETURN NEW; END; "`, `md5 = 44a734d202e32e7782c215138dc4c54e`
- staging `src` = `44a734d202e32e7782c215138dc4c54e`  (equals the applied canonical body)
- source `src` = `ff228cc831ee96ed74b31e275acb646e`  (md5 of source's raw prosrc — the normalization delta)

The two functions `match_memories_v2` and `memory_facts_semantic_search` are the 119↔121 gap: the generator did not
re-apply them (their `public.vector` argument renders differently in the identity-signature match), so they retain the
original migration's already-normalized body. Their attributes are identical like the other 119 — same artifact class;
their equivalence here rests on identical non-body attributes plus provenance (untouched since the original migration),
not on a body-hash check in this package.

**Conclusion.** The 121 are representation (prosrc-normalization) differences, not logic or signature differences. They
are safe to allowlist; the comparator is correct to flag a raw-byte difference and must not be weakened to hide it.

## 3. The 11 platform exceptions

| # | diff item | source | staging | why it cannot be corrected additively |
|---|---|---|---|---|
| 1 | extension `pg_cron` | pg_catalog 1.6 | absent | Supabase-managed extension; not installable on Aurora |
| 2 | extension `pg_net` | public 0.14.0 | absent | Supabase-managed; not on Aurora |
| 3 | extension `pgmq` | pgmq 1.4.4 | absent | Supabase-managed; not on Aurora |
| 4 | extension `supabase_vault` | vault 0.3.1 | absent | Supabase-only; not on Aurora |
| 5 | extension `vector` | 0.8.0 | 0.8.1 | staging is newer; no downgrade needed or wanted |
| 6 | owner `schema:public` | pg_database_owner | vitana_staging_admin | ownership model differs between Supabase and Aurora |
| 7 | matview `ai_usage_month_by_user_provider` | populated=true | populated=false | **definition is identical** (same def hash); only the populated/refresh state differs — a data/refresh step, not schema |
| 8 | fk `wallet_transactions_from_user_id_fkey` | NOT VALID | validated | staging is stricter; matching source would require a destructive drop/recreate to NOT VALID |
| 9 | fk `wallet_transactions_to_user_id_fkey` | NOT VALID | validated | same as #8 |
| 10 | check `partner_terms_acceptances_version_id_required` | NOT VALID | validated | same as #8 |
| 11 | view `VtidLedger` | def 7341b64f… | def 6e2b987a… (both `security_invoker=on`) | genuine view-definition difference, **deferred** from the atomic batch to avoid a rollback; now that `vtid_ledger` exists it is additively reconcilable via `CREATE OR REPLACE VIEW` if the owner wants it |

Items 1–10 are platform-bound or safe-as-is (staging equal-or-stricter). Item 11 is the one additively-reconcilable
exception, held back deliberately; it is not blocking.

## 4. Duplicate identity sequence introduced by the correction

The tables pass left one unintended object. Root cause: source's `plan_sparring_shadow_log.id` is an IDENTITY column
whose identity sequence is `plan_sparring_shadow_log_id_seq`. The generator both emitted the column as
`GENERATED BY DEFAULT AS IDENTITY` **and** emitted an explicit `CREATE SEQUENCE plan_sparring_shadow_log_id_seq`, so the
IDENTITY clause auto-created a second sequence `plan_sparring_shadow_log_id_seq1` to avoid the name collision. This shows
up as three A07 lines:

- `extra sequence|plan_sparring_shadow_log_id_seq1` (the duplicate, owner vitana_staging_admin)
- `extra owner|relation:plan_sparring_shadow_log_id_seq1`
- `changed sequence|plan_sparring_shadow_log_id_seq` (source `owned_by=…id:i` identity vs the explicit sequence on staging)

**Impact.** Harmless: `plan_sparring_shadow_log_id_seq1` is the live identity sequence of the column and is unused by
anything else; it does not block the DMS data load. **To match source exactly** the owner would drop the redundant
explicit sequence and let the identity sequence carry the canonical name — a DROP, hence outside the additive guard.
A one-line generator fix (skip the explicit `CREATE`/`OWNED BY` for an identity-owned sequence, dependency type `i`)
prevents the recurrence on any future regen.

---

## Owner decisions

1. **Allowlist the 121 normalization artifacts** (§2) — semantically identical, flagged only on raw-prosrc byte hash.
2. **Accept platform exceptions 1–10** (§3) — not correctable on Aurora, or staging is equal/stricter.
3. **Decide on view `VtidLedger`** (§3 item 11) — reconcile with `CREATE OR REPLACE VIEW`, or accept.
4. **`REVOKE EXECUTE … FROM PUBLIC`** on the seven functions (§1) to restore least privilege (non-additive).
5. **Optional:** drop the duplicate `plan_sparring_shadow_log_id_seq1` (§4) (non-additive).

After decisions 1–3 (allowlist/accept) the A07 residual is explained to zero in policy terms; A08 `function_grant`
closes after decision 4; A09 closes with the DMS data load. The comparator stays unchanged; none of the above weakens it.

## Hand-off to Kiro 2 (DMS)

Staging `public` now carries the correct six-table schema (empty) for the data migration. A09's three failures are the
preserved rows + sequence value in holding schema `vtid05803_preexisting` — the DMS load/cutover step, not a schema gap.
The duplicate identity sequence (§4) does not affect the load.

## Evidence index

- Comparator runs (this project's generic package registry, `vtid-05803-schema-acc/<run>/`): tables
  `20261119T184602Z` (A07 401→178), functions `20261119T185300Z` (→152), grants `20261119T190330Z` (→142) —
  `report.json`, `a07-diff.txt`, `a07-source.txt`, `a07-staging.txt`, `apply.stdout` per run.
- `docs/validation/VTID-05803/outputs/function-fingerprint-evidence.tsv` — all 121 functions, per-row proof for §2.
- `docs/validation/VTID-05803/acceptance.md` — AC-15..AC-20 (mechanism, probe diff, generator fixes, applied outcome).
