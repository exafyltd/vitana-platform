# Command Hub › Conversation — rebuild plan (supervisor view)

VTID: VTID-04484 · 2026-09-24 · status: plan, awaiting owner decisions (§10)

## 1. What the supervisor must be able to do

The owner's brief: a supervisor opens `/command-hub/conversation/` and can
**monitor** the ongoing conversations, and also **understand** why each one
went the way it did. Concretely, from this one section they need to be able to:

1. **See the whole conversation logic as a map.** That means every part
   (opening brain, scoring, tools, context/memory, navigation, hand-offs,
   guards, learning) and where each part is operated. Some parts are
   operated in other Command Hub sections (Voice, Assistant, Intelligence,
   Autonomy) or in the vitana-v1 admin screens (Navigator).
2. **See what is live on this stack right now.** That covers every flag with
   its effective value, every tool and on which surface/role it is declared,
   every opening provider and whether it is enabled, and the active scoring
   weights.
3. **Follow one session end to end.** Why this opening won, what the model
   was given (instruction budget, what got omitted), which tools it called,
   what it actually said, and which guards fired.
4. **Read the new scoring foundation.** Weights, scored-vs-fixed agreement,
   how often scoring changed the opening, and personal-weight coverage.
5. **Keep up with growth without UI work.** When a Vitanaland feature ships
   a new tool, opening provider or flag, it appears here automatically. The
   screen shows what is new, what is unwired and what is failing, and the
   build fails if something is added without being classified.

## 2. What exists today (read from the code)

Conversation section, 7 tabs (`NAVIGATION_CONFIG`, app.js):

| Tab | Reads | State |
|---|---|---|
| Config | `/api/v1/admin/conversation/*` | Uses a demo user and a hand-copied copy of the register model. It drifts from the real one. |
| Monitor | conversation-hub routes | Still says shadow ranking "changes nothing Vitana says". Since VTID-04454 scored ranking serves the opening, and `scored_openings` / `scored_changed_opening` are not shown anywhere. |
| Tool Health | tool health endpoints | No time-window picker. No button for the existing `POST /api/v1/admin/orb-tools/selfcheck`. |
| Simulator | register/NBA path only | Does not run the real provider ranking or the scored opening, so it cannot answer "what would open this session". |
| Awareness | awareness registry + test | The test view still says "Gemini". |
| Journey Context | journey context | Works; belongs with context. |
| Tool Catalog | `/api/v1/voice-tools/catalog`, `tool-manifest.json` | Has a Vertex/LiveKit "pipeline" column that no longer means anything. `tool-manifest.json` (683 entries) is maintained by hand/script and drifts from the code registry. |

Conversation-relevant screens that live in other sections today:

| Where | What | Note |
|---|---|---|
| Voice › Orb LIVE, Providers & Voice, Self-Healing, Test Contracts, test benches, Orb UI Monitor | transport, provider, voices, live transcripts | Keep there; link to them from Conversation |
| Assistant › Overview / Sessions / Personality / Experiments / Metrics | persona config, metrics | Sessions is empty. Experiments is localStorage only. `metrics/series` exists but is unused. |
| Intelligence & Memory (Dev) › Recall / Inspector | memory recall | Keep there; link |
| Integrations › Tools | a second copy of the tool endpoints | duplicate |
| vitana-v1 admin › Navigator (Catalog / Simulator / Coverage / Telemetry / History) | voice navigation | Not visible anywhere in the Command Hub. Backend `/api/v1/admin/navigator/*` already exists. |
| `/api/v1/orchestrator/*`, `/api/v1/admin/specialists/*` | delegation specialists, Devon hand-off | No Command Hub screen |

Backend already in place: `routes/conversation-hub.ts` (11 routes, each
`requireAuth` + `requireExafyAdmin`) and `conversation-hub-repository.ts`.

Defects found while reading (fix first, independent of the rebuild):

- **`GET /api/v1/voice-tools/catalog` has no auth.** It publishes the full
  tool catalog to anyone. Add `requireAuth` + `requireExafyAdmin`.
- **`/voice/next-action/inspector` has `requireExafyAdmin` without
  `requireAuth`.** Nothing populates the identity, so it most likely returns
  401 to everyone. Verify, then add `requireAuth`.
- **Stale text:** the Monitor's "changes nothing" line, "Gemini" in the
  Awareness Test, and the pipeline column in the Tool Catalog.

Blind spots that cost us this month:

- **Instruction budget.** The 30 KB instruction budget drops whole sections
  (bootstrap → history → specialist) and only logs to the console. The
  scaffold alone is ~32.4 KB, so every session loses the member's personal
  context and nobody can see it (VTID-04480 finding).
- **Loop guard and spoken backend data.** The loop guard firing on the
  opening turn, and a turn that reads backend data aloud, are only visible
  through ad-hoc `oasis_events` queries (VTID-04480).

## 3. The conversation logic, as the supervisor should see it

```
member speaks / opens ORB
  │
  ├─ 1 Session start ── transport + provider (Voice section owns)
  │
  ├─ 2 Opening brain ── 14 continuation providers (wake-brief-wiring.ts)
  │       → candidates → scored ranking (candidate-scoring.ts,
  │         conversation_scoring_weights, personal-weights.ts)
  │       → greeting rungs (compute-greeting-decision.ts) → opening line
  │
  ├─ 3 Context ──────── context pack + bootstrap + memory recall
  │       → instruction packer (30 KB budget) → what the model actually got
  │
  ├─ 4 Tools ────────── ORB_TOOL_REGISTRY → buildLiveApiTools (surface/role
  │       gates) → per-provider catalog budget → find_tool/use_tool
  │       (session-tool-selection.ts) → execution → result
  │
  ├─ 5 Navigation ───── navigator catalog → navigate/open_screen tools
  │
  ├─ 6 Hand-offs ────── report_to_specialist / switch_persona (Devon),
  │       delegate_to_agent specialists, voice-gender gate
  │
  ├─ 7 Guards ───────── loop guard, opening-turn budget, reply cap,
  │       backend-data mute, content-filter blocks, reconnects
  │
  └─ 8 Learning ─────── nightly jobs, offer outcomes, replay set,
          awareness registry, weights history
```

Each box becomes a place in the section; every box that is operated
elsewhere gets a deep link to where it is operated.

## 4. Target section: 9 tabs

The current 7 tabs are replaced. Every old URL keeps working through the
existing `/command-hub/...` route map, redirecting to its new home.

| # | Tab | What the supervisor sees | Data |
|---|---|---|---|
| 1 | **Overview** | Health strip, 24 h / 7 d: sessions, first-audio p50/p90, opening mix, scored-changed-opening rate, loop-guard fires (opening vs later), backend-speech mutes, context-omitted rate, content-filter blocks, hand-offs, tool failure rate. Alerts. "What changed since the last build" (new/removed tools, providers, flags). Wiring map (§3) with links out. | `oasis_events` aggregates (B3), `/system` (B1) |
| 2 | **Sessions** | Recent sessions list, filterable by guard fired / omitted context / hand-off / language / provider. Session inspector: opening decision (candidates, scores, winner, `ranking_mode`, `served_winner`), instruction budget per section and what was dropped, tool calls with timings and results, per-turn `output_preview`, guard events, link to Voice › Orb LIVE for the transcript. | session diag events (B2 adds the budget event) |
| 3 | **Opening** | Every provider from the live registry: priority, enabled, 7-day candidate/win counts, median latency, timeouts. Greeting rungs and their hit rates. Recent decisions. **Simulator** runs the real provider ranking + scored opening for a chosen user/context (read-only), replacing today's register-only simulator. | registry introspection (B1), events |
| 4 | **Scoring & Learning** | Active weights version and every feature weight, weights history, scored-vs-fixed agreement, `scored_changed_opening` over time, personal-weights coverage, top disagreements with both candidates side by side. Below it, the learning loop: nightly jobs (last run, result), offer outcomes, replay set, awareness test runs. **Read-only** (owner decision, §10). | B4, existing events + B3 |
| 5 | **Tools** | One catalog generated from the code registry. For each tool: domain/tier (`classifyOrbTool`), surfaces and roles it is declared on, priority / route group / deferred status, and whether it survives each provider's byte budget. Also calls, failure rate and p50 over a chosen window, plus a self-check button. **Coverage view:** feature (awareness registry) → tool → navigator entry, with gaps highlighted. Warnings: unclassified, unreachable on every surface, trimmed by budget, declared but never called in 30 d. Replaces Tool Health, Tool Catalog and Integrations › Tools. | B1, B3 |
| 6 | **Context & Memory** | Context pack builder inputs, instruction budget by section with 7-day omitted rate, awareness registry, journey context, memory recall health, profile freshness. Links to Intelligence › Recall / Inspector. | B2, existing routes |
| 7 | **Navigation** | Navigator summary: requests, resolved / near-miss / failed, top failed phrases, coverage gaps, blocked navigations. **Links to the existing vitana-v1 admin Navigator screens** (Catalog, Simulator, Telemetry); nothing is rebuilt in the Command Hub (owner decision, §10). | B5 (proxy of `/admin/navigator/telemetry` + `/coverage`) |
| 8 | **Hand-offs** | Vitana→Devon: `report_to_specialist` outcomes by STATUS, hand-offs refused for lack of a male voice (VTID-04445), `append_to_ticket` use, tickets filed from voice. Delegation specialists: which are registered on this stack, calls, results, persisted jobs. | B6 |
| 9 | **Configuration** | Every conversation flag: effective value on this stack, code default, staging pin, prod pin, and whether a value is invalid (e.g. `production` for a feature flag, VTID-04098). Registers / NBA config (read-only; editing stays where it is today). | B7 |

Layout rules: classes only (CSP gate), no inline style/script, the
`_convEl` inline-style helper is moved to classes, WCAG 2.2 AA, desktop
1400×900 and phone 390×844.

## 5. How the section picks up new work automatically

This is the "constant improvement" requirement: a new Vitanaland feature
adds a tool, the conversation logic can use it, and the supervisor sees it
without anyone editing the Command Hub.

1. **One introspection endpoint builds the picture from the same code the
   live session runs** (B1). It covers `ORB_TOOL_REGISTRY` and
   `buildLiveApiTools` for every surface × role, `classifyOrbTool`, the
   per-provider catalog budgets, the opening provider registry, the rungs
   and the flag registry. The screen cannot disagree with what a session
   declares, because both are built by the same functions.
2. **Build fingerprint.** At boot the gateway hashes that picture and
   records one `conversation.system.snapshot` event per build (a state
   transition, not a heartbeat). Overview diffs the current snapshot
   against the previous build: "3 tools added, 1 provider disabled, 2 flags
   changed".
3. **CI drift guard** (B9), failing the build when:
   - a tool in the registry has no classification;
   - a tool is declared on no surface and is not marked internal;
   - a tool is trimmed away by every provider budget it is meant for;
   - an opening provider is registered without a priority or a timeout
     class;
   - a conversation env flag is read in code but missing from the flag
     registry.

   This is the same shape as the VTID-03838 / VTID-04445 drift tests.
   Adding a feature forces it to be wired and visible in the same PR.
4. **`tool-manifest.json` becomes generated** from the registry by a script
   run in CI, instead of being maintained by hand. It stays for its
   existing consumers.

## 6. Backend work

| ID | Work |
|---|---|
| B1 | `GET /api/v1/admin/conversation/system` — registry introspection (§5.1), cached per build, `requireAuth` + `requireExafyAdmin`. |
| B2 | Emit the instruction budget as an `orb.live.diag` stage (`instruction_budget`: bytes per section, what was dropped). Today it is console-only. |
| B3 | Aggregates over `oasis_events` for tools (calls, failures, p50 per window) and for guards and openings. Served from the existing hub repository, with a bounded window and indexed columns only. |
| B4 | Scoring read API: active `conversation_scoring_weights` version and features, history, agreement / changed-opening series, personal-weights coverage. There is no read API today. |
| B5 | Navigator summary proxy over `/api/v1/admin/navigator/telemetry` + `/coverage`. |
| B6 | Hand-off stats: `report_to_specialist` STATUS counts, voice-gate refusals, delegation jobs. |
| B7 | Conversation flag registry: name, owner VTID, code default, parse rule. Effective values are read from the running process; staging/prod pins are read from the two deploy workflows at build time. |
| B8 | The fixes in §2: auth on `/voice-tools/catalog`, `requireAuth` on the next-action inspector, stale texts. |
| B9 | CI drift guard + generated manifest (§5.3–5.4). |
| B10 | Time-series charts from the unused `metrics/series` route. |

All reads, no new writes to member data. Nothing here touches what a
member hears; the only runtime change is one extra diag event per session
(B2).

## 7. Cleanup

- **Assistant section:** delete the empty Sessions tab and the
  localStorage-only Experiments tab (owner decision). Their legacy routes
  (`/command-hub/diagnostics/voice-lab/sessions/`, `.../experiments/`)
  redirect to Conversation › Sessions and Conversation › Overview.
  Personality and Metrics stay in Assistant.
- **Integrations › Tools:** delete it (owner decision); its route redirects
  to Conversation › Tools.
- **Old routes:** redirect them to their new tabs so bookmarks keep
  working.
- **Screen inventory:** add the Conversation screens to the screen
  inventory; they are missing today.
- **Ownership guard:** add the phase VTIDs to the allowlist in
  `scripts/ci/command-hub-ownership-guard.js`.
- **CLAUDE.md:** record the Command Hub carve-out from the "exactly 10
  sidebar items" rule. That rule is the community app's; the Command Hub
  has 24 sections and the carve-out was never written down.

## 8. Phasing

Each phase is its own VTID and PR and is merged to staging on its own. A
VTID is allocated when its phase starts.

| Phase | Contents | Size |
|---|---|---|
| 0 | B8 security and stale-text fixes | small; can ship today |
| A | Backend foundation: B1, B7, B2, B3 | medium |
| B | Overview, Tools (incl. coverage), Opening (incl. real simulator), Scoring & Learning (B4), Configuration, Sessions | large; split into two PRs |
| C | Navigation (B5), Hand-offs (B6), Context & Memory, learning panels in Scoring & Learning, wiring map, B10 charts | medium |
| D | B9 CI drift guard + generated manifest, dedupe/cleanup (§7), redirects | medium |

## 9. Verification

This session has no exafy_admin browser session. Every phase is therefore
verified in three ways:

1. On a local harness serving the real Command Hub files, fed with a
   read-only snapshot of real staging rows. Screenshots at 1400×900 and
   390×844, and every changed control clicked.
2. By the CSP, ownership and golden-fingerprint gates in CI.
3. On staging by the owner, with the URL list and what to look for in each
   PR.

The backend routes get jest suites, and B9 is mutation-checked: removing
the classification of one tool must fail the build.

## 10. Owner decisions (resolved 2026-09-24)

1. **Tab list:** 9 tabs, with Learning merged into Scoring (§4).
2. **Assistant › Sessions / Experiments:** deleted. Sessions is empty and
   Experiments only saves in the browser.
3. **Assistant › Metrics:** stays in Assistant.
4. **Scoring weights:** read-only in the Command Hub for now. Editing, if
   it ever comes, needs its own VTID with a governed, versioned write and
   an OASIS event.
5. **Navigator:** link to the existing vitana-v1 admin screens; no rebuild.
6. **Integrations › Tools:** removed as a duplicate of Conversation › Tools.
