# VTID-04424 — Conversation rebuild WS-3.1: giving Nova new information mid-conversation

This is Plan v1 (Conversation Intelligence Rebuild), Phase 3, workstream WS-3.1: a time-boxed technical test whose output is a decision note for plan v2. It ships in PR #3614 as a companion to VTID-04339.

## Change

- **`services/gateway/scripts/nova-midsession-probe.ts`**: a repeatable probe against real Nova 2 Sonic (eu-north-1) through the gateway's own `NovaSonicLiveClient` and protocol builders.
  - Polly-synthesised user speech is played in real time, and the probe waits out real-time playback so that no turn becomes an accidental barge-in.
  - 13 scenarios cover:
    - mid-session text injection in every role and interactive combination;
    - instant vs delayed tool results;
    - a `get_guidance` tool, with a plain note and a health-flavoured note;
    - two ways of changing the tool list mid-session.
  - Per run it records errors (verbatim, bounded), unsolicited responses, question-to-audio latency and recall.
- **`decision-note.md`**: results, what they mean, and the decision proposed for plan v2.
- **`outputs/probe-summary.json`**: per-scenario summary plus every run's answer, tool calls, errors and close.
- No production code path changes; the gateway does not import the script.

## Findings (39 live sessions, 3 per scenario)

- **Mid-session SYSTEM text fails the stream (6/6):** `Duplicate SYSTEM content. SYSTEM content can only be provided once per prompt.`
- **Non-interactive USER or ASSISTANT text** is accepted but ignored: recall 0/9.
- **Interactive USER text** is used, but Nova answers it unprompted every time (3/3 unsolicited responses).
- **The tool list is fixed per stream.** A second `promptStart` is rejected (`Duplicate prompt name`). `promptEnd` followed by a new prompt ends the stream.
- **Tool paths work (15/15 recall, no duplicates).**
  - A tool round trip adds its fetch time one-for-one: 1521 ms with an instant result vs 3024 ms with a 1.5 s delay.
  - `get_guidance` answered at 1589 ms against a 1004 ms baseline with the fact in the prompt.
- **Content filter:** 0 blocks in 39 sessions, including a health-flavoured note.

## Decision (proposed; owner decides in plan v2)

- Use a `get_guidance` tool that only reads a per-session note the advisor (WS-3.2) wrote asynchronously. Never inject text into the stream.
- `context_update` (WS-3.3) feeds the same session state.
- WS-3.4 chooses tools at connect time, and a mid-session `find_tool` has to be a lookup plus a generic dispatch tool.

## Acceptance

AC-1: The probe covers every option the decision note reports on, with unique scenario ids.
TEST: services/gateway/test/services/conversation/vtid-04424-nova-midsession-probe.test.ts

AC-2: Every injection scenario leaves a silent watch window of at least 5 s before the question, so unsolicited responses are observable.
TEST: services/gateway/test/services/conversation/vtid-04424-nova-midsession-probe.test.ts

AC-3: Injected notes, system prompts and guidance outputs are intents, never lines to recite.
TEST: services/gateway/test/services/conversation/vtid-04424-nova-midsession-probe.test.ts

AC-4: The summary reports errors, unsolicited responses, recall and median latency per scenario.
TEST: services/gateway/test/services/conversation/vtid-04424-nova-midsession-probe.test.ts

AC-5: The decision note and its evidence are committed, with one summary row per scenario.
TEST: services/gateway/test/services/conversation/vtid-04424-nova-midsession-probe.test.ts

## Limits

- Three runs per scenario, English only, one synthetic voice and one short fact.
- Recall and duplicate results were the same in every run of a scenario; latencies are indicative only.
- Zero filter blocks is not proof of zero risk; see the decision note.
