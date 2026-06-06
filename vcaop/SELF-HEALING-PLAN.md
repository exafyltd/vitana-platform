# VCAOP — Self-Healing Plan (autonomous recovery, human only as last resort)

> Same philosophy as the voice-to-voice auto-recovery for Vertex/LiveKit: when a
> component that **was** working breaks, the system detects it, diagnoses it, and
> drives it **back to the last known-good state on its own**. A human is paged
> **only** when the bounded remediation ladder is exhausted. Self-healing NEVER
> weakens a guardrail, NEVER touches production, and NEVER performs a destructive op
> without a tested rollback — those failures escalate immediately instead.

---

## 1. The loop (detect → diagnose → remediate → verify → restore | escalate)

```
        ┌────────────┐   signal    ┌─────────────┐  category  ┌──────────────┐
        │  DETECT    │ ──────────▶ │  DIAGNOSE   │ ─────────▶ │  REMEDIATE   │
        │ health     │             │ classify    │            │ ladder tier  │
        │ probe/OASIS│             │ failure     │            │ (bounded)    │
        └────────────┘             └─────────────┘            └──────┬───────┘
              ▲                                                      │
              │                          re-run health probe         ▼
              │                                               ┌──────────────┐
              │  green ◀────────────────────────────────────│   VERIFY     │
              │                                               └──────┬───────┘
        restore known-good (emit OASIS recovery event)               │ still red after N
              │                                                      ▼
              │                                              ┌────────────────┐
              └──────────────────────────────────────────── │   ESCALATE     │
                                                             │ human_task +   │
                                                             │ issue + freeze │
                                                             └────────────────┘
```

Every transition emits an OASIS event (`vcaop.heal.*`) so the whole incident is auditable.

## 2. Detection
- **Hourly/daily health probe** (`HEALTHCHECK-PLAN.md`) fails → triggers the loop.
- **Continuous OASIS watch**: a spike in `status:'error'` events, or a KPI crossing a
  Fail threshold, triggers the loop between scheduled probes.
- **Liveness**: `/alive` returns non-JSON / non-200, or Cloud Run rollout is stuck.

## 3. Diagnosis → failure category
The probe tags each failed check with a `category`. Category selects the remediation
tier (no guessing):

| Category | Signature | Example |
|----------|-----------|---------|
| `transient` | intermittent, passes on retry | network blip, cold start, rate-limit |
| `service`   | a deployed service is unhealthy | `/alive` down, 5xx, OOM, stuck revision |
| `schema`    | DB/migration fault | failed/partial migration, RLS missing |
| `config`    | drifted config/flags/policy | a policy row flipped, feature flag wrong |
| `dependency`| external vendor/credential failure | provider API 401/timeout, aggregator down |
| `guardrail` | a safety invariant itself failed | env-boundary/PII/human-gate test red |

## 4. Remediation ladder (bounded, escalating, each step VERIFIED)
Try the **cheapest, safest** action first; after each action, re-run the relevant
health probe; advance only if still red. Per-incident cap: **3 attempts per tier**,
exponential backoff, whole-incident budget per Sec. 0.5 (cost-guard applies).

| Category | Tier-1 (auto) | Tier-2 (auto) | Tier-3 (auto) |
|----------|---------------|---------------|---------------|
| `transient` | retry probe w/ backoff | re-run full suite | — → if still red, reclassify |
| `service` | restart / re-deploy **last known-good dev revision** (recorded in CICD) | scale to known-good flags (Sec. 0.5) | route traffic off bad revision (drop tag) |
| `schema` | run the tested **`down.sql`** to revert the last migration; re-apply known-good | restore from dev snapshot (if present) | — |
| `config` | **re-seed policies** (default-deny is safe) / reset flags to committed defaults | revert config to last green commit | — |
| `dependency` | flip the connector to **mock/degraded mode** via the swappable interface (keeps the rest of the system up) | open re-auth/human task for that provider only; quarantine it | — |
| `guardrail` | **NO auto-heal** — a failing safety invariant is never "fixed" automatically | — | immediate escalate + freeze writes |

Key recovery primitives that already exist in the build:
- **Deploy rollback** — CICD records the prior good dev revision; rollback = redeploy/route to it (dev only); tagged no-traffic revisions roll back by dropping the tag.
- **Migration rollback** — every migration ships a tested `down.sql` (Sec. 0.7).
- **Connector degrade** — `Connector`/`ApiClient`/`OAuthClient`/`BrowserDriver` are swappable, so a failing vendor is replaced by its mock/degraded impl without taking down the platform; OAuth revocation already auto-marks the account `degraded` + opens REAUTH.
- **Policy fail-closed** — re-seeding policy is always safe because unknown ⇒ denied.

## 5. Verify & restore
- After a successful tier, re-run `npm run health` (and the live probes when dev env
  exists). Green ⇒ emit `vcaop.heal.recovered` with the incident timeline and the
  tier that worked. The system is back to its original working state, no human involved.
- All healing actions are idempotent and leave an OASIS trail.

## 6. Escalate (the explicit "self-improving had no success → ask human")
Escalate immediately for `guardrail` failures, any would-be production/IAM/destructive
action, or a cost-ceiling breach. Otherwise escalate when the ladder is **exhausted**
(all tiers tried, capped attempts, still red). Escalation =
- create a `human_task` (type `PRIVILEGE_ESCALATION`/`IRREVERSIBLE_SUBMIT`) **and** open
  a GitHub issue tagged `vcaop-health` with: the failing checks, the category, every
  remediation attempted + its result, and the suspected root cause;
- **freeze** further automated writes for the affected component (degrade, don't thrash);
- page per on-call policy. This is the only path that puts a human in the loop.

## 7. Self-improvement (so recurrences heal faster)
Mirrors the voice-perf learning loop:
- Each incident records `{signature → category → remediation that worked → time-to-recover}`
  to the memory/OASIS store.
- The diagnoser consults this history first: a known signature jumps straight to the
  remediation that previously worked (skipping cheaper-but-useless tiers).
- A **new** signature with no known remedy runs the generic ladder; if generic
  remediation fails, it escalates (per §6) AND files the unknown signature for a human
  to encode a new remediation — which then becomes auto-healable next time.
- Guardrail: self-improvement may only **add** remediations or **reorder** safe ones;
  it can never invent an action that bypasses a guardrail or the dev-only boundary.

## 8. Hard invariants for the self-healer (never override)
1. Never weaken/disable a guardrail or delete a test to make health "green."
2. Never act on production; dev-only (Sec. 0.2). Stuck-prod ⇒ escalate, don't touch.
3. No destructive op without a tested rollback (Sec. 0.7); otherwise escalate.
4. Respect cost caps (Sec. 0.5); a heal that would breach budget escalates.
5. Every detect/remediate/verify/escalate step emits an OASIS event.
6. Bounded retries — never thrash; degrade-and-escalate beats infinite loops.

## 9. Status of this plan
The detection layer (`npm run health`, `VCAOP-HEALTH.yml`) and the recovery
primitives (down-migrations, revision rollback, connector degrade, policy re-seed)
**exist today**. The autonomous **orchestrator** that walks the ladder is the next
build step once a dev environment exists (BLK-001) — until then the hourly probe +
failure-issue path gives detection and human-routed recovery, and all primitives are
ready for the orchestrator to call.
