---
lane: gateway-write-guards
state: ready
next_actor: claude
executor: claude
depends_on: [command-hub-lane-guard]
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/routes/specs.ts
  - services/gateway/src/routes/triage-agent.ts
  - services/gateway/src/routes/ai-personality.ts
  - services/gateway/src/routes/llm.ts
  - services/gateway/src/routes/email-intake.ts
  - services/gateway/src/services/operator-planner.ts
  - services/gateway/src/services/gemini-operator.ts
  - services/gateway/src/services/task-intake-service.ts
  - services/gateway/src/frontend/command-hub/app.js
  - services/gateway/src/frontend/command-hub/index.html
  - services/gateway/specs/command-hub-symbol-index.json
  - services/gateway/test/governance-write-route-auth.test.ts
  - services/gateway/test/specs-generate-claim.test.ts
  - services/gateway/test/delivery/command-hub-delivery.test.ts
  - docs/validation/*/staging-tests.json
updated: 2026-11-17T15:10Z
---
# Lane — gateway-write-guards

Goal (plan §2 Lane B): the eight unguarded write routes behind `requireServiceOrAdmin`; callers send the gateway token;
the llm audit actor from the verified identity; the Command Hub header changes; the `?v=` bump for `app.js` and
`styles.css` together; the staging-suite version updates; the regenerated symbol index. Content is PR #5106 commits
`55df6aa9`, `d61978e4`, `bb738c03`, moved without change. Acceptance: plan §4 Lane B.
