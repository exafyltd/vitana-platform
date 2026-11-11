# VTID-05718 — acceptance

Change: a chat message is held 20 s (CHAT_PUSH_BURST_HOLD_MS; 0 restores the immediate push). One push per burst: the newest unread text, prefixed "{count} new messages · " when there is more than one.

AC-1: A burst of three messages from one sender in one conversation leaves as one push with body "3 new messages · <last text>".
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a burst of three held messages leaves as ONE push: the latest text and the count"

AC-2: A single held message is sent with its own text and no count.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a single held message is sent with its own text and no count"

AC-3: A burst that is not yet due is left alone.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a burst that is not due yet is left alone"

AC-4: Read during the hold: nothing is sent and the held rows are recorded suppressed_read.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "read during the hold: nothing is sent and the held rows are recorded suppressed_read"

AC-5: Two sweeps do not send the same burst twice.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a second sweep does not send the same burst again"

AC-6: A claim left in sending is reclaimed after 60 s and sent.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a claim left in sending by a crash is reclaimed and the burst is sent"

AC-7: A dispatch failure ends that burst (dispatch_exception) with no retry loop.
TEST: test/vtid-05718-chat-burst-sweep.test.ts > "a dispatch failure gives up on that burst (dispatch_exception), with no retry loop"

AC-8: Push-dispatch and the push health check ignore held and claimed rows; rows with a NULL push_outcome still dispatch.
TEST: test/vtid-05718-push-dispatch-filter.test.ts > "applies the NULL-safe push_outcome filter"
CURL: GET /alive on the staging gateway returns 200 after the sweep starts (docs/validation/VTID-05718/staging-tests.json)

AC-9: The 5-minute coalescing window (VTID-05137) and CHAT_PUSH_COALESCING_ENABLED=false keep their behaviour; a new message is held and joins a pending burst as coalesced.
TEST: test/vtid-05137-chat-push-coalescing.test.ts > "a message joining a burst already held for this conversation is coalesced"
TEST: test/vtid-05137-chat-push-coalescing.test.ts > "CHAT_PUSH_COALESCING_ENABLED=false pushes every message without reading"

## Evidence
- Unit and contract tests: see the TEST lines above. Local runs were not possible in this session (npm registry unreachable, no jest binary); CI's gateway Jest job is the runner. See commands.log.
- Staging: docs/validation/VTID-05718/staging-tests.json (gateway /alive). No write to production; burst behaviour is proven by Jest.

## OASIS impact
None: no OASIS event is emitted by this change.
