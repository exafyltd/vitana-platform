# WS-3.1 decision note — giving Nova new information mid-conversation

VTID-04424 · Plan v1 Phase 3 · input to plan v2

## Question

How can the conversation brain give Nova 2 Sonic new information during a
live conversation without Nova treating it as a turn to answer? Three
options were on the table:

- (a) a Nova system update that does not trigger a response;
- (b) pre-fetching, so tool calls return instantly;
- (c) a `get_guidance` tool the model calls itself.

WS-3.4 also depends on a second question: can the tool list change
mid-session?

## How it was measured

`services/gateway/scripts/nova-midsession-probe.ts` opens real Nova 2 Sonic
streams (`amazon.nova-2-sonic-v1:0`, eu-north-1) through the gateway's own
`NovaSonicLiveClient` and protocol builders. It plays Polly-synthesised user
speech into the long-lived audio block in real time, and it waits out
real-time playback before the next user turn so that no turn becomes a
barge-in. All content is synthetic: one short fact ("diary streak is 7
days"), with no user data and no gateway or database involved.

There are 13 scenarios with 3 runs each (39 sessions). For each run the probe
records:

- whether the stream errored;
- **unsolicited responses**: assistant audio that starts while no user
  utterance is pending;
- **latency**: from the end of the user's question audio to the first
  assistant audio chunk;
- **recall**: whether the spoken answer used the injected fact.

Raw per-run output is in `outputs/probe-summary.json`.

## Results

| Scenario | Errors | Unsolicited | Answered | Recall | Latency p50 | Tool→audio p50 |
|---|---|---|---|---|---|---|
| Fact in the opening system prompt (baseline) | 0/3 | 0 | 3/3 | 3/3 | 1004 ms | — |
| (a) SYSTEM text mid-session, non-interactive | **3/3** | 0 | 0/3 | 0/3 | — | — |
| (a) SYSTEM text mid-session, interactive | **3/3** | 0 | 0/3 | 0/3 | — | — |
| (a) USER text, non-interactive | 0/3 | 0 | 3/3 | **0/3** | 1235 ms | — |
| (a) ASSISTANT text, non-interactive | 0/3 | 0 | 3/3 | **0/3** | 1101 ms | — |
| (a) USER text, non-interactive, health-flavoured note | 0/3 | 0 | 3/3 | **0/3** | 1097 ms | — |
| (a) USER text, interactive | 0/3 | **3** | 3/3 | 3/3 | 1028 ms | — |
| (b) Fact tool, result returned instantly | 0/3 | 0 | 3/3 | 3/3 | 1521 ms | 657 ms |
| (b) Fact tool, result after 1.5 s | 0/3 | 0 | 3/3 | 3/3 | **3024 ms** | 636 ms |
| (c) `get_guidance`, short note | 0/3 | 0 | 3/3 | 3/3 | 1589 ms | 712 ms |
| (c) `get_guidance`, health-flavoured note | 0/3 | 0 | 3/3 | 3/3 | 2451 ms | 751 ms |
| Tool list: second `promptStart` in the same stream | **3/3** | 0 | 0/3 | 0/3 | — | — |
| Tool list: `promptEnd` then a new prompt in the same stream | 0/3 | 0 | **0/3** | 0/3 | — | — |

Verbatim errors:

- Mid-session SYSTEM text: `Duplicate SYSTEM content. SYSTEM content can only be provided once per prompt.`
- Second `promptStart`: `Duplicate prompt name: <uuid>`

After `promptEnd` and a fresh prompt, Bedrock closed the stream about 200 ms
later with no error event.

**Content filter:** no block in any of the 39 sessions, including the
health-flavoured note, whether it arrived as injected text or as a tool
result.

## What this means

1. **Option (a) does not exist on Nova 2 Sonic.**
   - SYSTEM content is accepted once per prompt. A second SYSTEM block, in
     either interactive mode, is a validation error that fails the stream.
     In production that would be an outage, not a degraded answer.
   - Non-interactive USER or ASSISTANT text is accepted and then ignored:
     recall was 0/9 across three wordings.
   - Interactive USER text is used (3/3), but Nova answers it every time
     (3/3 unsolicited responses). That is exactly the duplicate-response
     failure this test exists to rule out.
2. **The tool list is fixed for the life of a stream.** A second
   `promptStart` is rejected. Ending the prompt and starting a new one
   ends the stream. Changing the tools means a new stream, which the
   gateway already opens on context-upgrade reconnects.
3. **Tool round-trip time is added one-for-one to the user's wait.** The
   same question took 1521 ms with an instant tool result and 3024 ms with a
   1.5 s fetch. Nova itself needs about 650 ms from receiving a tool result
   to first audio, so a tool turn costs about 0.5 s more than having the
   fact in the prompt (1521 vs 1004 ms), even when the result is instant.
4. **A `get_guidance` tool works when the prompt tells the model to call
   it.** The model called it in 6/6 runs, used the note in its own words in
   6/6, and proposed the next step the note asked for (log today's entry;
   a breathing exercise). There were no duplicates and no filter reactions.

## Decision (proposed for plan v2)

- **Use (c) and (b) together; never (a).** The live advisor (WS-3.2) writes
  its note **asynchronously, off the audio path**, into a per-session cache.
  `get_guidance` only **reads** that cache and returns at once, or returns
  "no note" if none exists yet. It must never compute a note inside the
  tool call, because every millisecond there is added to the user's wait
  (finding 3).
- **The system prompt tells the model when to call `get_guidance`** (at the
  start of a turn about the user, a plan or a next step), not on every
  turn. The ~0.6 s tool cost is then paid only where it buys something.
- **Guidance notes follow the existing wording rules.** Notes are intent,
  never a sentence to recite (NEVER-rule 41), and written as positive
  instructions (the VTID-04124 finding on content-filter blocks, which
  this probe's small sample does not overturn).
- **WS-3.3 (`context_update`) writes into the same session state** that
  `get_guidance` and `get_current_screen` read. It never injects text into
  the Nova stream.
- **WS-3.4 picks the tool set at connect time.** Mid-session, `find_tool`
  cannot add declarations. It has to be a lookup plus a generic dispatch
  tool (for example `find_tool` returns a name and argument schema, and
  `use_tool(name, args)` runs it through the existing dispatcher). A
  surface change large enough to need a different tool set goes through
  the existing reconnect path.

## Limits of this test

- Three runs per scenario, English only, one synthetic voice, one short
  fact. The recall and duplicate results are unanimous in every cell
  (0/3 or 3/3). The latency medians are indicative, not a service-level
  target.
- Content filter: zero blocks in 39 sessions is not evidence of zero risk.
  Production has shown the filter reacting to instruction shape
  (VTID-03797, VTID-04124). The advisor's notes need their own watch on
  `nova_validation` diagnostics once they run on staging.
- Not measured: how often the model chooses to call `get_guidance` without
  an explicit rule, and the cost of a tool-set reconnect.
