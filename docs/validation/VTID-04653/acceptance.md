# VTID-04653 — shrink the fixed rules in Vitana's voice instruction

VTID: VTID-04653

## Why

Step 3 of the personal-context plan. Every voice session sends the same fixed rules
before the member's own context. Many rules were stated two or three times: the
how-to vs. hand-off rule (3×), "vary your phrasing" (3×), "never ask what they want"
(RULE 0 and TONE RULES), get_current_screen (navigator and JOURNEY AWARENESS), and
the whole silent swap-back and consent rules (TOOLS and the persona block). The
identity lock sent to Vertex still carried the persona denial list Nova's filter
rejects (Nova got a sanitized copy).

## What changed

Every rule is kept and stated once. Nothing about tools, greetings or memory writes.

- `ai-personality-service.ts` voice_live defaults: identity/names, greeting,
  interruption, repetition, tools and role text reworded without duplicates.
- `live-system-instruction.ts`: role/handle/name headers, identity lock (now the
  Nova-safe wording for every provider), TONE RULES, JOURNEY AWARENESS, PROACTIVE
  OPENER OVERRIDE, the unpinned TOOLS bullets. RULE 0, GUIDED JOURNEY, the
  hand-off and message-send truthfulness rules are unchanged.
- `orb-live.ts`: Vitana's persona block (specialists unchanged), messaging
  contract, navigator v2 (the one production runs) reflowed.
- `nova-instruction-sanitizer.ts`: same identity-lock wording.

## Measured (payload identity harness, navigator v2 as in production)

| Session | Total before | Total after | Fixed rules before | after |
|---|---|---|---|---|
| returning member (en) | 27,894 | 20,853 | 23,787 | 18,494 |
| first day (de) | 26,787 | 19,746 | 23,628 | 18,335 |
| guided topic (de) | 28,196 | 21,155 | 22,003 | 16,710 |
| admin surface | 10,629 | 8,473 | — | — |
| Command Hub | 12,343 | 10,183 | — | — |

Bytes, UTF-8. `outputs/bytes-before.txt`, `outputs/bytes-after.txt`.

Not reached: the ~12 KB target. The rest is RULE 0 (2.6 KB), GUIDED JOURNEY
(1.9 KB) and the TOOLS truthfulness rules, each pinned by contract tests from
real incidents; shortening them further means changing behaviour rules, not
removing duplicates, and needs its own measured change.

## Acceptance

AC-1: every voice surface's instruction shrinks and only instruction text changes (tool catalogs, greeting decisions, memory writes byte-identical).
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-2: every reworded behaviour rule still holds (RULE 0 labels, offer integrity, name/handle/role headers, navigator, hand-off truthfulness).
TEST: services/gateway/test/orb/conversation-flow.contract.test.ts

AC-3: the name header stays a lookup that obeys the turn directive.
TEST: services/gateway/test/orb/live/instruction/authoritative-user-name.test.ts

AC-6: each deduplicated rule appears once, the identity lock is Nova-safe for every provider, and the instruction stays under a measured ceiling (26,336 → 18,932 bytes on the pinned call).
TEST: services/gateway/test/orb/live/instruction/vtid-04653-scaffold-each-rule-once.test.ts

AC-4: specialists (Devon) keep their full behavioural block.
TEST: services/gateway/test/routes/orb-live.test.ts

AC-5 (staging): spoken sessions as the test account still answer "Wem folge ich?", open matches, stop on "Schluss", and show no new content-filter blocks.
UI: https://preview-aws.vitanaland.com (voice harness, see outputs/staging-voice.txt after merge)
