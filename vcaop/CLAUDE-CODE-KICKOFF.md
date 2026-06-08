# Claude Code - Kickoff / Handoff: BUILD VCAOP END TO END

> Paste this as your task, or drop it at the repo root (you may merge it into `CLAUDE.md`).
> Authoritative spec: `vcaop/VCAOP-BUILD-RUNBOOK.md` (Rev. 2). Read it in full before doing anything else. Paths in these docs are repo-relative: read them at `vcaop/`, not filesystem root.

---

## MISSION
Build the **Vitanaland Commerce & Account-Operations Platform (VCAOP)** end to end, in one continuous initiative, fully autonomously, dev/staging only, mock-first, tested and verified, resuming across as many sessions as it takes until Definition of Done. **Make every decision yourself, from beginning to end. Do not ask the human questions. Do not wait for confirmation to start - begin now.**

## WHERE TO PICK UP
1. Read `vcaop/VCAOP-BUILD-RUNBOOK.md` completely. It is the source of truth (architecture, data model, guardrails, VTID build plan in Sec. 6, execution loop in Sec. 11, Definition of Done in Sec. 0.9).
2. Create/read the state files in `vcaop/`: `CURRENT-STATE.md`, `BLOCKERS.md`, `ESCALATIONS.md`, `APPROVALS.md` (human-written; you only read it), `DECISIONS.md`.
3. From then on, run the per-session loop in runbook Sec. 11. At the start of every session, read `CURRENT-STATE.md` and resume exactly where you left off.

## EXECUTION DIRECTIVE - ONE GO, NO QUESTIONS
- Build the entire initiative: **every VTID in runbook Sec. 6, in dependency order, starting with `CTRL-GUARD-0001`.** Do not stop at a phase boundary - keep going through all layers (CTRL, IAM, VAULT, CONN, KYB, AGNT, RWD, CMRC, UIC, UIA, OBS, CICD).
- **Make all engineering decisions yourself** (libraries, schema tradeoffs, file layout, mock shapes, test design, refactors). Log them to `DECISIONS.md`. Never pause to ask the human.
- **Run continuously across sessions.** A session ending is not a stop. At the end of every task update `CURRENT-STATE.md` (including rollback notes for any migration/deploy) so the next session resumes seamlessly, then continue. Keep picking up and building until Definition of Done.
- **Self-verify as you go.** A VTID is `DONE` only when its acceptance criteria pass plus `test:guardrails` and the relevant `iam`/privacy tests. The initiative is done only when the mock end-to-end flows pass: "onboard mock supplier -> operate" and "shop mock merchant -> SubID attribute -> wallet credit -> confirm postback -> reversal" (runbook Sec. 0.9, Sec. 7).

## THE FEW THINGS THAT ARE NOT YOUR CALL (handle as specified - never ask, never violate)
You still decide everything; these are simply non-negotiable behaviors already defined in the runbook. "No questions" means you never interrupt the human to choose - it does NOT mean bypassing these.
- **The 8 hard limits** (runbook Sec. 0.3): no fabricated credentials; no auto KYC/KYB/liveness; no CAPTCHA solving; no storing user loyalty credentials; no point pooling/resale/account marketplace; single canonical identity; no secrets in DB/logs/OASIS; no PII in logs/prompts/traces/screenshots/browser artifacts/OASIS/fixtures. Enforced as code + tests; never weaken a guardrail to make a feature pass.
- **Dev/staging only** (Sec. 0.2): never deploy/route production, never touch production data, never run destructive DB ops, never change IAM, never provision billing-impacting infra. Deploy only to `*-dev` services or tagged no-traffic Gateway revisions, with recorded rollback (Sec. 0.7).
- **Tier-B safe-default rule** (Sec. 0.4): for the narrow set of sensitive decisions (security, privacy/legal, cost beyond Sec. 0.5 caps, destructive/production infra) you do NOT ask the human and you do NOT perform the dangerous action - choose the safe / more-restrictive option, log it to `ESCALATIONS.md`, and keep building everything else. Because this build is dev-only and mock-first, this should rarely trigger and must never stop overall progress while any independent task remains.
- **Missing real credentials / approvals / unverified vendors**: never fabricate or guess. Verify official docs first (Sec. 0.8); if unavailable or gated, build a mock to the same interface, log it to `BLOCKERS.md`, and continue. These are expected, not failures.

Net effect: you build the whole system in one go without ever interrupting the human. The safe-default rule is just how you make the handful of sensitive choices on your own without doing anything destructive.

## ORDER OF OPERATIONS (first session)
1. `git checkout -b feature/vcaop` (create if absent). **Never push to `main`/`master`; never force-push.**
2. Create the five state files in `vcaop/`.
3. Confirm the dev-environment target via `env-boundary` before any migration or deploy.
4. Build `CTRL-GUARD-0001` first: the guardrails package incl. `env-boundary`, `no-pii-leak`, `cost-guard`. Make `npm run test:guardrails` green and wire it as a required CI gate **before building any feature.**
5. Proceed through the Sec. 6 VTID order. For each: build -> run AC + guardrail/iam/privacy tests -> commit referencing the VTID -> emit an OASIS progress event -> update `CURRENT-STATE.md`.
6. Deploy only to dev (`gcloud run deploy <service>-dev --source . --region us-central1 --max-instances=2 --timeout=300s`; never `gcloud builds submit`), recording rollback first.

## WHEN DONE
At Definition of Done (Sec. 0.9), write `vcaop/FINAL-REPORT.md` containing:
- VTIDs `DONE` / `BLOCKED(external)` / `AWAITING-APPROVAL`, with reasons.
- Everything that was mocked, and the exact real credentials/approvals/IAM/production steps a human must supply to go live (the runtime human tasks).
- Test results (guardrails, iam, privacy, unit, integration, mock e2e) and the dev deploy + rollback notes.
- Any Tier-B items logged in `ESCALATIONS.md` awaiting human sign-off.

## START NOW
Read `vcaop/VCAOP-BUILD-RUNBOOK.md`, create the branch and state files, then begin `CTRL-GUARD-0001` and continue autonomously through the entire build. Do not reply with questions; build.
