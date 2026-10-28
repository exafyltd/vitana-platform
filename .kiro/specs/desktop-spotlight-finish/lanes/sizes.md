---
lane: sizes
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/CommunityFiltersPopup.tsx
  - src/components/CreateEventPopup.tsx
  - src/components/CreateGroupPopup.tsx
  - src/components/CreateMeetupPopup.tsx
  - src/components/EditMeetupPopup.tsx
  - src/components/EducationMasterActionPopup.tsx
  - src/components/ErrorNotificationStack.tsx
  - src/components/GlobalErrorBoundary.tsx
  - src/components/GoLivePopup.tsx
  - src/components/HealthMasterActionPopup.tsx
  - src/components/InviteSheet.tsx
  - src/components/MediaUploadPopup.tsx
  - src/components/NewConversationPopup.tsx
  - src/components/ServicesMasterActionPopup.tsx
  - src/components/admin/AdminActivityFeed.tsx
  - src/components/admin/AdminFilterBar.tsx
  - src/components/admin/SignupFunnelChart.tsx
  - src/components/admin/SplitDetailPanel.tsx
  - src/components/admin/analytics/AnalyticsCharts.tsx
  - src/components/admin/analytics/AnalyticsShared.tsx
  - src/components/admin/notifications/NotificationCategoriesTab.tsx
  - src/components/admin/rewards/RewardItemForm.tsx
  - src/components/audio/SoundscapeControl.tsx
  - src/components/contacts/AddContactDialog.tsx
  - src/components/contacts/VerifyPhoneDialog.tsx
  - src/components/dev/CommandCenterView.tsx
  - src/components/dev/EventDetailDrawer.tsx
  - src/components/dev/ExecutionLogsList.tsx
  - src/components/dev/LiveConsole.tsx
  - src/components/dev/OperatorChat.tsx
  - src/components/dev/TaskCard.tsx
  - src/components/dev/TemplatesLibrary.tsx
  - src/components/dev/TimelineView.tsx
  - src/components/dev/modals/CreateCommandModal.tsx
  - src/components/dev/modals/CreateTaskModal.tsx
  - src/components/dev/modals/ExportLogsModal.tsx
  - src/components/dev/modals/TriggerRunModal.tsx
  - src/components/dev/status/StatusDetailsDrawer.tsx
  - src/components/messages/CreateGroupPopup.tsx
  - src/components/messages/GroupMembersModal.tsx
  - src/components/messages/ReactionPopover.tsx
  - src/components/messages/mobile/MobileConversationSkeleton.tsx
  - src/components/notifications/NotificationsPanel.tsx
  - src/components/settings/GoogleConnectionVerifyDialog.tsx
  - src/components/settings/OAuthBouncePendingOverlay.tsx
  - src/components/settings/PartnerLabsConsentDialog.tsx
  - src/components/templates/RecommendationCard.tsx
  - src/pages/Changelog.tsx
  - src/pages/messages/Inspiration.tsx
  - src/pages/patient/Appointments.tsx
  - src/pages/settings/Billing.tsx
  - src/pages/settings/Support.tsx
  - tests/e2e/staging/vtid-*-sizes.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
updated: 2026-10-21T23:30Z
vtid: VTID-05293
---
# Arbitrary sizes and the last non-colour findings in files without raw palette (owner decision 2) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: sizes -->`
(tasks Z1) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 52 files with findings in this lane's paths ΓÇö `design/no-arbitrary-size` 63 ┬╖ `design/no-physical-direction` 2 ┬╖ `design/no-raw-content-card` 5.

**Goal.** Clear `design/no-arbitrary-size` (and the few `no-raw-content-card` / `no-physical-direction` findings) in the 52 files that have no raw palette finding. Exact Tailwind value ΓåÆ that class; Γëñ 2 px away ΓåÆ nearest class; otherwise keep with `// design-allow-next-line: <reason>`.

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned file; every kept size has a one-line reason (`npm run design:allowances` lists them, PR body summarises the count by reason).
- Baselines lowered; Vitest + build + lint green.
- Staging spec (read-only): the popups/dialogs reachable without a write open at 1440 and 390 without horizontal scroll.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration ┬º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z ┬╖ kiro-202610152203-0347 ┬╖ created ΓåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/sizes --session <id>`).

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05293 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
