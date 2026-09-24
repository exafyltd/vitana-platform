# Conversation replay cases (VTID-04443, Plan v1 WS-4.4)

Each JSON file in `cases/` is one conversation reduced to what the conversation
brain decides from: the opening context, the continuation providers' results,
and the turns that follow (screen, what the user said).
`test/services/conversation/vtid-04443-conversation-replay.test.ts` replays every
case through the real decision functions. It checks the case's `expect` block and
snapshots the whole transcript.

A conversation-logic change that changes any replayed decision fails CI until the
snapshot is updated on purpose (`npm run test:replay -- -u`) and the diff is
reviewed in the PR.

## Rules

- **Synthetic by default.** Invent the user's words; never paste a real member's.
- **Recorded cases need consent.** Use `npx tsx scripts/record-replay-case.ts
  --summary <saved brain-inspector JSON> --id <case-id> --consent <reference>`.
  It keeps language, route, opener and provider statuses only, and never the user
  id, the session id or any spoken text. The author then adds synthetic turns and
  expectations.
- **No ids.** No UUIDs, emails or `user_id` / `session_id` / `tenant_id` keys; the
  test enforces this.
- **Every case states its expectations.** The snapshot catches drift; the `expect`
  block says what the case is *for*. Every case also enforces NEVER-rule 41: no
  opening may ask the model to recite text.

## Case fields

| Field | Meaning |
|---|---|
| `opening.greeting` | Overrides on the default returning-user opening context (`defaultReplayGreeting`). |
| `opening.providers` / `winner` | The continuation providers' results and the ranker's winner. |
| `outcomes` | Per-provider accepted / declined / ignored history (personal weights, WS-4.3). |
| `personal_weights_live` | Mirrors `BRAIN_PERSONAL_WEIGHTS=true` (staging) for the live leads. |
| `turns[]` | `route` / `screen_title` (a `context_update`), `user` (synthetic text) and optional `find_tool` query. |
| `expect` | `opener_kind`, `register`, `silent_opening`, `candidate_provider`, `candidate_spoken`, `shadow_winner`; per turn `route_groups`, `declared_tools_include`, `reachable_tools_include`, `find_tool_top`, `top_lead_provider`, `advisor_eligible`. |
