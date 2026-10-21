# Nova 2 Sonic — Production Voice-Provider Cutover Proposal

**VTID:** none allocated yet — this document is the prerequisite a future
execution VTID must reference and satisfy, mirroring the pattern
`docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412) established for the general
GCP→AWS infrastructure cutover.
**Status:** Proposal / governance artifact — **does not authorize
anything.** No Nova traffic has been routed to production as a result of
this document.
**Author:** Claude Code session `session_01M5oEMYRbMCpXMFqnQF46eC`, 2026-07-29.

---

## 0. What this document is (and isn't)

This is a **decision-support proposal**, not an execution plan with
approval already granted. It exists because the user asked to "finish
everything else to switch and go LIVE" with Nova replacing Vertex as the
production voice provider, and the honest answer that day was: not yet,
here is exactly what's true today and exactly what's still missing.

**This document does not authorize a cutover.** Per the same governance
model `docs/AWS-CUTOVER-RUNBOOK.md` uses for the general AWS
infrastructure cutover, switching the production voice provider requires:

1. Every item in the **Go/No-Go Checklist** (§2) to be true, and
2. A **separate, explicitly-approved execution VTID** that references this
   document and is itself gated on `spec_status=approved`, and
3. Explicit user sign-off before Nova serves a single real (non-canary)
   production user — this is a live, audio, customer-facing UX change,
   not a backend infra swap.

This proposal is scoped **narrowly to the voice provider** (Vertex vs.
Nova for ORB voice-to-voice). It is a distinct decision from, and does not
piggyback on, the general GCP→AWS gateway infrastructure cutover
(VTID-03419) — that VTID moved *where the gateway process runs*; it said
nothing about *which LLM voice provider it uses*. The fact that
`gateway.vitanaland.com` is now served by AWS ECS (`vitana-gateway-awsdr`,
confirmed live 2026-07-29 — see §1) removes one technical blocker (Cloud
Run cannot carry Nova's Bedrock bidirectional HTTP/2 stream; ECS can) but
does not by itself make Nova production-ready.

---

## 1. Current-state summary (as of 2026-07-29)

| Area | State |
|---|---|
| Production gateway platform | **AWS ECS** (`vitana-gateway-awsdr`), confirmed live via `curl gateway.vitanaland.com/api/v1/admin/health` → `env:"production"`, matches `dr-gateway.vitanaland.com` byte-for-byte. GCP Cloud Run is no longer serving `gateway.vitanaland.com`. This happened under VTID-03419 (2026-07-27); the user has confirmed this was an authorized action, though its OASIS governance trail is incomplete (autonomous-engine-generated spec, self-approved as `"approved_by": "unknown"`, never reached `is_terminal=true` — `missing_stages: [PR_CREATED, MERGED, VALIDATOR_PASSED, DEPLOY_SUCCESS]`). Documented here as current-state fact, not re-litigated. |
| Nova canary status | Enabled on **AWS staging only** (`vitana-gateway`, `preview-aws-gateway.vitanaland.com`) — 4 individually-allowlisted users + the internal `vitana` dev tenant (`00000000-0000-0000-0000-000000000001`) as of today. **Zero Nova traffic has ever been served from `vitana-gateway-awsdr` (real production).** |
| Nova prod deploy plumbing | `AWS-PROD-DEPLOY-GATEWAY.yml` already has `nova_sonic_enabled` / `nova_canary_user_ids` / `nova_canary_tenant_ids` `workflow_dispatch` inputs and the jq upsert logic to write them onto the prod task definition — built in anticipation, **never dispatched**. Mechanically ready; never exercised. |
| Nova prod IAM | **Unverified.** The one-time `bedrock:InvokeModel` least-privilege policy (`docs/NOVA-SONIC-CANARY-RUNBOOK.md` §1) was applied to whatever task role `vitana-gateway` (AWS staging) uses. Whether `vitana-gateway-awsdr` (AWS-DR prod) uses the *same* task role or a separate one — and therefore whether it already has Bedrock invoke permission at all — has not been checked in this session (no working AWS CLI credentials available). **Must be verified before any prod dispatch**, or the first prod Nova session fails on `AccessDeniedException`, not gracefully. |
| Tool-loop-guard bug | **Fixed today** (PR #2984, merged, deployed to AWS staging). Root cause: the guard's synthetic break-response used a raw `{success:false, error:...}` shape that Nova read as "tool failed, try another" rather than an instruction — confirmed via live OASIS data (session `live-be473671...`, 16→35+ consecutive tool calls, never recovering). Fixed by reusing the existing `graceToolResultForModel` success-shaped pattern, plus a hard-ceiling alert backstop. **Not yet observed stopping a real loop in the wild** — the fix is logically sound and unit-tested, but no live `tool_loop_guard_activated` event has fired against the new code yet to empirically confirm it. |
| Latency | Highly bimodal, confirmed via 5 live back-to-back staging sessions today: first session after any idle gap ≈ 8-10s to first audio (cold — both connection *and* model-generation phases pay a "cold" tax); every session immediately following a real inference call ≈ 2.6-3.8s (both phases warm). Vertex baseline from an earlier controlled comparison: 5.37s. **Sessions arriving close together beat Vertex; isolated/infrequent sessions do not.** Real production traffic volume/pattern — which determines which regime users would actually experience — is unknown, because Nova has never carried production traffic. |
| Soak test | **Started today** (this proposal's companion action) — Nova canary expanded to the internal `vitana` dev tenant on AWS staging. Runbook calls for "one working day" of observation before the canary is considered a validated cohort; that clock starts now, not before. |
| Governance | **No execution VTID exists for a production voice-provider cutover.** This document is the prerequisite for one, not the VTID itself. |

**Bottom line:** the one blocker removed since this morning is
platform-level (prod is AWS ECS now, which technically *can* run Nova).
Every other blocker — no prod IAM verification, unverified tool-loop fix
in production traffic, latency behavior under real (not synthetic)
traffic patterns unknown, no soak-test data yet, no execution VTID — is
unchanged.

---

## 2. Go/No-Go Checklist

Every item must be true before an execution VTID for the actual
provider cutover can reach `spec_status=approved`.

- [x] **Tool-loop-guard bug fixed** — PR #2984, merged, deployed to AWS
      staging 2026-07-29.
- [ ] **Tool-loop-guard fix observed working on real traffic** — at least
      one genuine `tool_loop_guard_activated` event on the post-fix code,
      confirmed via OASIS to have stopped the loop (no `hard_ceiling_exceeded`
      alert following it, or `consecutive` bounded rather than climbing).
- [x] **Nova canary expanded to internal tenant** — done today, AWS
      staging only.
- [ ] **One full working day of internal-tenant soak observed** — zero
      unplanned disconnects, zero unrecovered tool loops, zero silent
      Vertex-fallback surprises for canary-eligible sessions, usage/cost
      within expected bounds. Clock started 2026-07-29; not complete.
- [ ] **AWS-DR prod task role's Bedrock IAM permission verified** — confirm
      `vitana-gateway-awsdr`'s task role (same as or different from
      `vitana-gateway`'s) can call `bedrock:InvokeModel` on
      `amazon.nova-2-sonic-v1:0` in `eu-north-1` *before* any prod
      dispatch, via `aws iam simulate-principal-policy` (same check the
      canary runbook's §1 already prescribes for staging).
- [ ] **Latency behavior validated under realistic traffic density** — not
      just isolated back-to-back test sessions; needs data from the soak
      test's actual usage pattern, since the cold/warm split found today
      is highly sensitive to request frequency.
- [ ] **Production rollback mechanism confirmed** — `ORB_LIVE_PROVIDER=vertex`
      emergency override (referenced in the canary runbook §6) verified to
      work on the AWS-DR prod task definition specifically, not just
      staging.
- [ ] **Execution VTID allocated and spec-approved**, referencing this
      document, with an explicit "why now" and a **named human approver**
      — not an autonomous-engine self-approval, given the governance gap
      already found in VTID-03419's trail (§1).
- [ ] **Explicit user sign-off obtained** for which cohort goes first
      (another canary expansion in prod? straight to 100%? a specific
      tenant?) and the specific activation window — this is the step that
      cannot be automated away by any checklist, same principle as the
      DNS cutover runbook states for its own domain.

---

## 3. Proposed Activation Sequence (for the execution VTID to follow)

Mirrors the staged-canary pattern already proven on AWS staging, moved to
`vitana-gateway-awsdr`:

1. Verify prod IAM (§2 checklist item) — read-only, safe to do anytime.
2. Dispatch `AWS-PROD-DEPLOY-GATEWAY.yml` with `nova_sonic_enabled=true`
   and the **same 4 individual canary users** (not the whole tenant yet)
   — the smallest possible blast radius on real production.
3. Observe for a defined window (recommend matching the staging soak: one
   full working day) — watch OASIS for `orb.upstream.nova.*` events,
   `tool_loop_guard_activated`, `voice.latency.measured`, and any
   `connection_issue` surfaced to real users.
4. Only after that window is clean: expand to the internal tenant in
   prod, repeat the observation window.
5. Only after *that* is clean, and with a fresh explicit sign-off: propose
   a broader cohort or 100% cutover as a **separate** decision — this
   document does not pre-authorize going past the internal-tenant stage.

No step in this sequence touches `system_config['voice.active_provider']`
(the shared GCP/AWS config row) — per the canary runbook's own explicit
warning, that must never be flipped for canary work; it would affect GCP
too, which is out of scope entirely (GCP Cloud Run still cannot carry
Nova's protocol, cutover or not).

---

## 4. Open Decisions (must be resolved by the user, not assumed)

### 4.1 Cohort sequencing in production

Does production cutover replay the same staged sequence as staging (4
users → internal tenant → broader), or does the user want to skip
straight to a different cohort given staging validation? **No default
assumed.**

### 4.2 Cost/usage bounds

Nova's cost profile per session hasn't been compared against Vertex's in
this session. Before real users hit it at any scale, is there a defined
budget/alert threshold that should gate continued rollout? **No default
assumed.**

### 4.3 What "done" means for this proposal

Is the goal eventually 100% Nova in production (Vertex retired), or a
permanent split (e.g., Nova for canary/internal users, Vertex as the
stable default) with Nova only ever expanding by explicit further
decisions? This changes what the "success" criterion for the whole
initiative even is. **No default assumed.**

---

## 5. Rollback Plan

- **Trigger conditions:** any `tool_loop_guard_activated` event with
  `hard_ceiling_exceeded:true` in production, first-audio p95 exceeding
  1.2× the Vertex baseline sustained over a rolling window, any
  `connection_issue` surfaced to a real (non-canary-test) user, or a
  manual call by whoever owns the activation window.
- **Mechanism:** `ORB_LIVE_PROVIDER=vertex` emergency override (verify
  this works on `vitana-gateway-awsdr` specifically as part of §2's
  checklist — do not assume parity with staging untested), or narrow the
  canary allowlist back down / disable via the same
  `AWS-PROD-DEPLOY-GATEWAY.yml` dispatch mechanism used to enable it.
- **No DNS/infra rollback needed** — this is a provider-selection change
  within the already-running AWS gateway, not an infrastructure cutover,
  so it's reversible by config alone.

---

## 6. Relationship to other work this session

| Item | State | Relationship |
|---|---|---|
| PR #2984 | Merged | Tool-loop-guard fix — prerequisite, done |
| PR #2988 | In review | Internal-tenant canary expansion (staging) — the soak test this proposal depends on |
| Live latency measurement (5 sessions, 2026-07-29) | Done | Informs §1/§2's latency findings |
| VTID-03419 | Executed 2026-07-27, governance trail incomplete | Removed the Cloud-Run technical blocker; does not itself cover voice-provider selection |
| `docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412) | Existing pattern | This document's structure and governance posture directly mirror it |
