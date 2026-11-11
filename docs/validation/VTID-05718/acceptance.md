# VTID-05718 — acceptance

Change: a chat message is held 20 s (CHAT_PUSH_BURST_HOLD_MS; 0 restores the immediate push). One push per burst, the newest unread text, with "{count} new messages · {preview}" when there is more than one.

## Acceptance criteria
1. A burst of three messages from one sender in one conversation leaves as one push: body "3 new messages · <last text>".
2. A single message is sent with its own text.
3. Read during the hold: nothing is sent; the held rows are recorded suppressed_read.
4. Two sweeps do not send the same burst twice.
5. A claim left in "sending" is reclaimed after 60 s and sent.
6. A dispatch failure ends that burst (dispatch_exception) with no retry loop.
7. Push-dispatch and the push health check ignore held and claimed rows (NULL-safe filter); rows with a NULL push_outcome still dispatch.
8. The 5-minute coalescing window (VTID-05137) and CHAT_PUSH_COALESCING_ENABLED=false keep their behaviour.

## Evidence
- Unit and contract tests: test/vtid-05718-chat-burst-sweep.test.ts (sweep cases above) and test/vtid-05137-chat-push-coalescing.test.ts (contract updated: first message is held; the window and the off switch unchanged).
- Local runs: not possible in this session (npm registry unreachable, no jest binary); CI's gateway Jest job is the runner.
- Staging: docs/validation/VTID-05718/staging-tests.json (gateway /alive after the sweep starts). No write to production; the burst behaviour is proven by Jest.

## OASIS impact
None: no OASIS event is emitted by this change.
