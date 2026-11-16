# Handoff: VTID-05023 staging Aurora cutover and sparring/reviewer model roles

Written by a Claude Code session on 2026-11-16 for a Kiro session to continue. Read this first.

## 1. Goal
Serve the staging gateway's `/rest/v1` traffic from the Aurora rehearsal copy through the PostgREST-Aurora proxy ("option 1"). Staging only. Production is out of scope until the owner gives Gate 2.

## 2. Status
- Done earlier: rehearsal defaults applied (1,910 OK, 8 fixed, 2 columns added). The proxy was repointed to the rehearsal copy via CI (PR #5087 merged). The CI secret permission was fixed by an owner-run script.
- Plan history for the staging split:
  - v1: withdrawn. Its deploy target was wrong (the CI emit step, not the gateway runtime).
  - v2: withdrawn. It proposed a new `DATA_REST_URL` variable and a `--rest-url` flag.
  - v3: withdrawn after round 3. The existing `--backend aurora` seam already splits REST: `services/postgrest-aurora-proxy/nginx.conf.template` (lines 39-72) passes `/auth`, `/storage`, `/functions` and `/realtime` through to Supabase.
- Sparring: 3 rounds used (standard cap). Round 3 verdict: NOT CONVERGED. Escalated to the owner. Open items:
  - F12 (major): the proxy is internal only (Cloud Map, `postgrest-aurora.vitana.internal:8080`). GitHub runners and sessions cannot probe it, so plan v3's probes are not runnable as written.
  - F13 (major): gateway writes on staging would land in the rehearsal database while the preview frontend still writes to production Supabase. That is split-brain. The DMS replication mode is unverified.
  - F14 (major): the JWT-secret check (P0) must name the project staging uses, check the token algorithm (HS256 vs asymmetric), and pass `vtid-05023-supabase-public-url-cutover.test.ts`.
  - F15 (minor): no VTID or plan-sparring record for the infra dispatch.
- Owner decisions still open:
  - D1: accept split-brain for a bounded window? Accept `SUPABASE_URL` on staging resolving to the proxy?
  - D2: accept gateway writes to the rehearsal database (this replaces the earlier "no write" rule)?
  - D3: a staging test-account credential for sign-in and refresh.
  - P0: an owner-run AWS CloudShell digest check (the session cannot read the secret values).
- Nothing has been implemented, committed or deployed for this plan.

## 3. Sparring and reviewer model roles (second thread, open)
- Sparring partner: the candidate next-generation Bedrock model. A minimal invoke in eu-central-1 succeeded. Tool use and adaptive thinking are NOT yet verified, and the sparring code requires both.
- Reviewer: the candidate small-tier Bedrock model. A minimal invoke succeeded. It is not in the reviewer fallback chain.
- Model identifiers for both are in the owner's session notes, not in this file (repo rule: no model identifiers in repo artifacts). Ask the owner for them.
- Quotas: unknown. The agent role cannot read Service Quotas (AccessDenied). An owner console check, or a read grant, is needed.
- The sparring default constant still points at the previous-generation primary profile (`services/gateway/src/constants/llm-defaults.ts`). It has not been changed.
- The reviewer chain (`services/gateway/src/services/project-manager/governance.ts`) has not been changed.
- Sparring fallback chain: primary, then the Bedrock fallback, then the last-resort provider (platform CLAUDE.md rule 53). Earlier Bedrock "too many tokens per day" errors mean quota decides whether the candidate model can be the default.

## 4. Hard constraints
- Staging tests are read-only (platform CLAUDE.md rule 48). No writes as the test account (rule 31). Never test against production.
- No secrets in chat, files or commits. Print digests or verdicts only.
- Production change needs Gate 2 ("Staging verified — ready for deployment to production?"). Gate 1 is the owner's yes on a sparred plan.
- Plan sparring: the plan body goes between `<!-- plan:begin -->` and `<!-- plan:end -->`. Standard cap is 3 rounds, then escalate. A fresh sparring session counts as a new plan.
- Kiro collaboration: at session start run `node scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>`. Claim a lane before touching it. Git is the only channel. Rules: `.claude/rules/collaboration.md`.
- Pull requests: draft, then subscribe to PR activity after creating one.

## 5. Suggested first steps
1. Run the collab queue. Confirm the VTID-05023 lane is yours and claim it before editing.
2. Get the owner's answers to D1, D2, D3 and P0. Do not dispatch any staging deploy before P0 passes.
3. Write plan v4 that fixes F12–F15: probe from inside the VPC (through the gateway, or an owner-run ECS exec), add a gateway-read health gate, define a rollback trigger, and add a VTID and sparring record. Run it through sparring as a fresh session.
4. For the model roles: run one tool-use and adaptive-thinking call on the sparring candidate before changing the sparring default. Get quota numbers from the owner before making it the default.

## 6. Key files
- Proxy routing: `services/postgrest-aurora-proxy/nginx.conf.template` (lines 39-72 passthrough, 106 fallback). Proxy README: `services/postgrest-aurora-proxy/README.md`.
- Seam: `scripts/aws/taskdef-data-backend.py` (`apply_backend`; `SERVICES["gateway-staging"]`; modes `keep`, `aurora`, `supabase`).
- Workflow: `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` (`data_backend` input near line 60; taskdef step near 1355–1370; CI emit step near 1471–1495, which is CI-only, not runtime).
- Gateway clients: `services/gateway/src/lib/supabase.ts`, `lib/supabase-user.ts`, `routes/auth.ts`, `lib/supabase-public-url.ts`.
- Sparring: `services/gateway/src/constants/llm-defaults.ts`, `services/gateway/src/services/plan-sparring/partner.ts`.
- Reviewer chain: `services/gateway/src/services/project-manager/governance.ts`.
- Rules: platform `CLAUDE.md` (rules 46–55, Autonomy Contract), `.claude/rules/collaboration.md`, `.claude/rules/infrastructure.md`.

## 7. Known gaps
- The sparring round records (rounds 1–3) exist only in the Claude Code session's task output, not in git. Ask for them or re-run sparring.
- P0 is unverified. Nothing in this handoff has checked the JWT secret.

## 8. Status update: suspected shared project vs verified writes (2026-11-16)

Owner instruction: take ownership of VTID-05023 through staging verification. Staging cutover and sign-in tests stay ON HOLD until the checks below pass. Production cutover is outside this session.

| Claim | Status | Evidence / what settles it |
|---|---|---|
| Staging and production use one Supabase project | SUSPECTED | `CLAUDE.md` rule 31 and vitana-v1 `CLAUDE.md` say one project serves every frontend. `docs/STAGING.md` (2026-05-22 snapshot) says staging is a separate project. Settled by O2 (project reference). |
| The staging gateway writes to production today | UNVERIFIED | Would follow from the shared project plus keep mode. Needs O2 and a write-path trace (gateway, preview browser, background jobs). Not established. |
| The proxy's effective database target | PENDING O1 | The authenticator-URI secret exists (metadata checked, value not read). Its host is the open question. `PGRST_DB_HOST`/`NAME`/`PORT` are probably inert in PostgREST v12 (`db-uri` is the setting); not verified here. |
| Writes through the proxy | NOT ESTABLISHED | Sampled log streams showed GET traffic only. That is not evidence of no writes. Needs a read-only database check of insert/update/delete counters over a window, plus the pg_cron job state on the rehearsal database. |
| P0: staging JWT secret equals the signing secret of the project the staging URL points to | PENDING O2 | The check must compare against the signing secret of the project the staging URL names, and record the token algorithm. |
| D3: test identity for sign-in and refresh | BLOCKED | If staging is production, sign-in targets production, which rule 48 forbids. Not usable until O2 shows isolation. |

Correction to section 2: the F13 "split-brain" framing assumed separate projects. If the shared-project suspicion is confirmed, frontend and gateway write to the same production database. That is more serious than F13 says, and it is an owner decision, not a plan detail.

Owner checks: O1 (effective database host) and O2 (staging project reference, JWKS algorithm, JWT-secret digests). Each prints only a host, a reference, a digest or a verdict.

## 9. Owner check results (2026-11-16, CloudShell)

| Check | Result | Status |
|---|---|---|
| O1: effective database host of the Aurora authenticator URI | rehearsal cluster | VERIFIED (plan v4 Branch A) |
| O2: staging Supabase project reference | the production project | VERIFIED: staging points at production |
| O2: staging gateway JWT secret equals production JWT secret | SAME | VERIFIED (digest) |
| O2: JWKS keys published by the project | none | INFERRED: shared symmetric secret (HS256). Not checked against a real token header |
| P0 | digest passes; algorithm inferred | PASS WITH CAVEAT: the proxy's secret matches production. Live token check still needed |
| Staging writes to production: which writes, how many | not measured | UNESTABLISHED: needs one read-only audit query on production (owner decision 2) |
| Staging gateway write control | none exists on main | OPEN: decision 1 (scale staging to zero, reversible) |

Earlier O2 run had a script bug (the `.supabase.co` suffix was not stripped). The corrected command gives the results above. Do not use the earlier `shared_with_prod: NO` or `jwks_algs: UNREACHABLE` output.

Still on hold: staging cutover, sign-in, D3 (blocked while the staging project is production). Open decisions: 1 scale staging gateway to zero; 2 one read-only production audit query; 3 review of production jobs; 4 separate staging Supabase project; 5 D3 stays blocked; 6 lane reassignment.
