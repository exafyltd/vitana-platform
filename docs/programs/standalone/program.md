---
id: standalone
title: Standalone work (specs outside the named programmes)
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:pm-agent
  - vitana-platform:claude-sessions-handover
  - vitana-platform:retire-claude-code
  - vitana-platform:plan-spar-stale-session
  - vitana-platform:fix-4182-test-fallout
  - vitana-platform:collab-queue-perf
  - vitana-v1:chat-ux
  - vitana-v1:vitana-chat-markdown
  - vitana-platform:collab-multi-builder-handoff
  - vitana-platform:collab-kiro-governance
  - vitana-platform:kiro-primary-executor
  - vitana-platform:kiro-autonomy-fallback
  - vitana-platform:kaf-fallback-env
  - vitana-platform:claude-md-cleanup
  - vitana-platform:messenger-ux-v2
  - vitana-platform:ci-github-modernization
  - vitana-platform:ci-ecr-public-auth
  - vitana-platform:outbox-test-dates
  - vitana-platform:pm-reassign-idempotent
  - vitana-platform:pm-reassign-idempotent-r2
  - vitana-platform:pm-reassign-idempotent-r3
  - vitana-platform:matches-scroll-end
  - vitana-platform:spotlight-commit-coverage
  - vitana-platform:wallet-fx-rate-url
  - vitana-platform:profile-posts-full-width
  - vitana-platform:staging-verify-runner-fix
  - vitana-platform:guard-required-only-preflight
  - vitana-platform:reviewer-model-fallback
  - vitana-platform:i18n-audit-nightly-off
  - vitana-platform:fix-deeplink-scroll-test
  - vitana-platform:pipeline-speed
  - vitana-platform:kiro-web-steering
  - vitana-platform:owner-autonomy
  - vitana-platform:step-order-gate
  - vitana-platform:sv-05308-coverage
  - vitana-platform:kiro-web-parity
  - vitana-platform:kiro-web-reliability
  - vitana-platform:plan-spar-stuck-session
  - vitana-platform:session-title-stable
  - vitana-platform:pipeline-lane-state-efficiency
  - vitana-platform:operating-workflow
  - vitana-platform:pm-ci-load
  - vitana-platform:pipeline-agent-wake-and-review
  - vitana-platform:context-map
  - vitana-platform:quality-checks
  - vitana-platform:quality-checks-followup
  - vitana-platform:reviewer-step-model
  - vitana-platform:collab-handoff-check-fix
  - vitana-platform:remove-b12-claude-sparring-gate1
  - vitana-platform:reviewer-session-id-permission
  - vitana-platform:kiro-lane-admin
  - vitana-platform:say-hello-lane-reassign
  - vitana-platform:i18n-propagate-stale-write
  - vitana-platform:sparring-floor-retry
  - vitana-platform:ci-dockerhub-mirror
docs:
  - vitana-platform:.kiro/specs/pm-agent/plan-sparring.md
  - vitana-platform:.kiro/specs/claude-sessions-handover/handoff.md
  - vitana-v1:.kiro/specs/chat-ux/plan-sparring.md
  - vitana-v1:docs/validation/VTID-05193/plan-sparring.md
exit_criteria:
  - Every spec listed here is done or has moved to a named programme
next_review: 2026-10-22
---
# Standalone work

Programme registry entry (VTID-05215). Every current `.kiro/specs/*` spec belongs to exactly one programme; specs that
belong to none of the named programmes are listed here until the owner assigns them to one. Links only.

- `vitana-platform:pm-agent` — Project Manager Agent
- `vitana-platform:claude-sessions-handover` — handover of ongoing Claude Code sessions to Kiro
- `vitana-platform:plan-spar-stale-session` — PLAN-SPAR re-runs dead in_progress sparring sessions
- `vitana-platform:fix-4182-test-fallout` — staging suite + Jest pin left stale by #4182 (VTID-05082)
- `vitana-platform:collab-queue-perf` — collab queue reads git in a constant number of processes
- `vitana-v1:chat-ux` — chat UX
- `vitana-v1:vitana-chat-markdown` — Vitana chat replies render Markdown
- `vitana-platform:messenger-ux-v2` — Messenger: reliable sending, scroll, replies, media, search, sharing, push suppression
- `vitana-platform:kiro-autonomy-fallback` — Claude Code optional; Kiro runs the pipeline end to end
- `vitana-platform:kaf-fallback-env` — fix-forward: the staging PM sees Kiro-fallback mode (VTID-05277)
- `vitana-platform:claude-md-cleanup` — trim CLAUDE.md to project-specific rules (both repos)
- `vitana-platform:ci-github-modernization` — modernize CI/GitHub for both repos (dead removal, false-positive fixes, speed, CI-health)
- `vitana-platform:ci-ecr-public-auth` — authenticated public.ecr.aws base-image pulls in stage/prod image builds (both repos)
- `vitana-platform:outbox-test-dates` — VTID-05320 send-status test fixtures relative to now (vitana-v1)
- `vitana-platform:pm-reassign-idempotent` — the PM's stale-review reassignment writes nothing when nothing changed
- `vitana-platform:pm-reassign-idempotent-r2` — re-plan of `pm-reassign-idempotent/reassign-noop` with a Kiro executor and `types.ts` in its paths (supersedes VTID-05363)
- `vitana-platform:pm-reassign-idempotent-r3` — re-plan of `pm-reassign-idempotent-r2/reassign-noop-r2` with the regenerated `conversation-flag-pins.generated.ts` in its paths (supersedes VTID-05414)
- `vitana-platform:matches-scroll-end` — the phone Matches list (`/me/matches`) scrolls to its last card (vitana-v1)
- `vitana-platform:spotlight-commit-coverage` — STAGING-VERIFY coverage for the 10 desktop-spotlight merges without a VTID (vitana-v1)
- `vitana-platform:profile-posts-full-width` — profile Posts tab: avatar header on top, post text/media full width (vitana-v1)
- `vitana-platform:staging-verify-runner-fix` — STAGING-VERIFY: pinned runner image, native suite commands, bundle profile (both repos)
- `vitana-platform:reviewer-model-fallback` — retroactive spar + VTID + read-only staging coverage for the reviewer-agent three-model fallback chain merged in #4295
- `vitana-platform:pipeline-speed` — Kiro pipeline time-to-completion: zero-cost empty slots, one-pass preflight, restart watchdog
- `vitana-platform:kiro-web-steering` — Kiro Web sessions load both repos' steering and the pipeline driver (generated workspace-root steering, AGENTS.md trigger, Configuration Sync file)
- `vitana-platform:owner-autonomy` — one standing autonomy rule for every Vitana session and process; one complete stop table; guard-checked (both repos)
- `vitana-platform:step-order-gate` — pipeline step order enforced in code (`scripts/collab/land-guard.mjs`)
- `vitana-platform:sv-05308-coverage` — the missing VTID-05308 staging suite so gateway STAGING-VERIFY passes
- `vitana-platform:pipeline-lane-state-efficiency` — one closing record may carry a chain of legal lane/plan transitions (every edge, its evidence and the append-only log checked)
- `vitana-platform:pm-ci-load` — superseded PR runs cancel; the Project Manager gets its own GitHub App identity (own rate limit)
- `vitana-platform:pipeline-agent-wake-and-review` — wake an absent driver on sparring/review events, an independent reviewer tier gated by shadow qualification, CI merge of converged plan PRs
- `vitana-platform:kiro-web-parity` — Kiro Web session kit: ready tools, enforced local typecheck/preflight before commit/push, CI wait with failed logs
- `vitana-platform:kiro-web-reliability` — one-command Kiro Web bootstrap, race-free commit/push git hooks, VALIDATOR-CHECK in preflight, parallel lane builders
- `vitana-platform:plan-spar-stuck-session` — a PLAN-SPAR session whose partner never answers recovers inside the same run
- `vitana-platform:session-title-stable` — always-included steering rule in both repos: the session title is set once and never renamed
- `vitana-platform:context-map` — one read-only command and one linked page to find routes, screens, areas, importers, rules and prior work; stale-link check
- `vitana-platform:quality-checks` — proportional quality checks per change type for planning, building, review and staging proof; BOM-tolerant manifests; PR templates (both repos)
- `vitana-platform:reviewer-step-model` — every pinned review step's prompt opens with its own chain model, so the reviewer agent's self-check stops returning `model_unavailable`
- `vitana-platform:quality-checks-followup` — merge-method wording (squash), quality checks inlined into Kiro Web steering, reviewer requester rule (protected)
- `vitana-platform:operating-workflow` — one authoritative operating policy, central review independence, durable driver record, CI activity guard, proportional path, workflow metrics
- `vitana-platform:reviewer-session-id-permission` — the reviewer agent generates its own reviewer session id via the existing queue.mjs command (narrowest shell permission; protected gate file, owner-authorized)
- `vitana-platform:ci-dockerhub-mirror` — vitana-v1 PR CI pulls its Postgres service image from Docker Hub, not the capped ECR Public mirror
