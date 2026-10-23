# Vitana pipeline — the default for every session (VTID-05278)

Every owner task that results in a commit runs the Vitana pipeline end to end: `plan(<slug>)` PR → CI PLAN-SPAR →
CI-allocated VTIDs → parallel lanes → reviewer agent `vitana-lane-reviewer` (`claude-sonnet-5.5` → `claude-opus-5.5` → `claude-sonnet-4.5`) → serialized merge
to `main` under the PM merge rule → staging auto-deploy → STAGING-VERIFY → Gate 2 *"Staging verified — ready for
deployment to production?"*. Rules: `.claude/rules/collaboration.md` §7–§8b.

- **Kiro IDE:** launch `.kiro/workflows/vitana-pipeline.workflow.json` with the owner task.
- **Kiro Web** (no workflow engine): follow `.kiro/pipeline/driver.md` in one continuous session.
- Do not ask the owner for approval of git, push, PR, merge, re-runs, sparring rounds or VTIDs. The only owner stops
  are Gate 2 and an escalated sparring verdict, plus the stop cases of `collaboration.md` §7 (security or data-loss
  risk, a failure surviving 3 fix-forward attempts, anything touching production).
- VTIDs come only from CI PLAN-SPAR; never hand-allocate.
- Production after Gate 2: the owner's PUBLISH in the Command Hub, **or Kiro publishes when the owner explicitly
  commands it in this conversation** — either a full publish (the same promotion as the Command Hub button, pinned to
  the commit that passed STAGING-VERIFY) or a session-scoped publish of only the changes one session made (this
  session or a session id the owner names), pinned per CLAUDE.md IF–THEN 26 — stop and tell the owner if anything else
  would ship. Never in an unattended run. Rules: `collaboration.md` §7c. Never test against or write to production or
  any live system.
