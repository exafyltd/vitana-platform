# HANDOFF — Vertex Serbian bridge: authenticated sessions still hit `1007`

> **RESOLVED — VTID-04026.** The §3 lead was half right: the failure IS the
> aggregate context being too large, but it is the TOOL CATALOG (290
> declarations, 226 KB), not the instruction the budget guard already
> bounds. Confirmed live with the same script, only `--route=/admin`
> (134 declarations, 45 KB): 8/8 vs 2/8. Fix: `orb/live/tools/vertex-tool-
> catalog-budget.ts`. Evidence: `docs/validation/VTID-04026/`. §5 (thinking
> text spoken pre-login) is still open and still not to be touched.

**VTID:** VTID-04021 (this document) — continues the VTID-04010 → VTID-04014
→ VTID-04015 chain, all merged, all deployed to staging, **problem not
solved**.

**Who this is for:** a fresh Claude Code session picking this up with no
memory of the investigation. Read this whole document before touching
code — it tells you what's already been tried and ruled out, so you don't
repeat it.

**Current live state (as of 2026-09-17 ~21:40 UTC):** the platform owner
reported ORB voice stuck in an endless "Hold on, I'm reconnecting" loop
after login. Root-caused to authenticated Serbian (`lang:'sr'`) sessions
against the Vertex Serbian bridge (VTID-04000) closing with
`upstream_ws_close code:1007 reason:"Request contains an invalid
argument."` at a **stable ~80% failure rate**, even after two rounds of
fixes. **The platform owner explicitly asked to stop iterating blindly and
get a proper handoff instead — this is that handoff.**

---

## 1. What's already fixed and confirmed working — don't re-litigate

- **Pre-login (anonymous) Serbian voice works at the connection/audio
  level.** 10/10 anonymous trials (this session, direct-API technique, see
  §4) got session/start OK, SSE 200, real audio, zero `1007` closes.
  **However — see §5, a separate bug was found in this same flow.**
- **VTID-04010 (PR #3378, merged `99f4731`):** fixed the real bug where
  `safe_fast_proactive` (the post-login "welcome back" greeting rung,
  `compute-greeting-decision.ts`) only had German/English text pools, so
  Serbian (and every other non-DE/EN language) silently spoke English.
  This fix is correct and should stay.
- **VTID-04014 (PR #3384, merged `ecfc0df`):** VTID-04010's directive text
  told the model to "translate the following ... verbatim ... do not
  leave any part of it in English" — this is a quote-and-recite-verbatim
  shape that Vertex's guardrail rejects, and it made EVERY authenticated
  Serbian session fail with `1007` immediately after deploy (measured:
  6/6, zero prior occurrences in 7 days). Fixed by rewording to the same
  "compose freely from a lead, don't recite it" pattern the sibling
  `override_v2` rung already used successfully. **This fix is real and
  should stay** — it moved the failure rate from ~100% to ~80% and one
  trial produced genuinely fluent, correct Serbian.
- **VTID-04015 (PR #3385, merged `75fd50b`):** hypothesized that
  VTID-04014's directive still explicitly naming the language ("Speak
  entirely in Serbian — use no English words") was the remaining trigger,
  since `override_v2` never names a language at all. **This fix did NOT
  measurably help** — live re-verification after deploy: still only 2/10
  succeeded (statistically indistinguishable from before). It's a
  reasonable simplification (matches the proven-safe sibling rung's
  pattern more closely) and is architecturally clean, so it's fine to
  keep, but **do not expect it to be the fix**.

**Net effect of all three PRs combined:** failure rate went from ~100%
(nothing worked, always English) → ~100% (1007 close) → **~80% (1007
close), stable across two different directive rewordings.**

## 2. The actual open problem

At current `main`/staging (commit `75fd50b` and later), **authenticated
Serbian sessions fail with `upstream_ws_close code:1007 reason:"Request
contains an invalid argument."` roughly 80% of the time**, regardless of
how the `safe_fast_proactive` greeting directive is worded. This is what's
causing the live-reported reconnect loop: `attemptTransparentReconnect()`
(`routes/orb-live.ts`, search for `VTID-STREAM-RECONNECT`) resends the
turn-0 setup on every retry, and since the reconnect keeps failing the
same way, the client's spoken "Hold on, I'm reconnecting" cue
(`orb-widget.js`, `case 'reconnecting':` → `_announceDisconnect('connection')`)
fires on every retry — an audible endless loop.

**Two directive-wording fixes did not change the failure rate.** That's
strong evidence the greeting-rung text was never the (sole) cause. Move on
from that hypothesis unless you find new evidence for it.

## 3. The strongest lead — READ THIS FIRST

While investigating, found a **near-identical, already-documented prior
incident** in this exact codebase:
`services/gateway/src/orb/live/instruction/live-system-instruction.ts`
around line 407-423 (search `BOOTSTRAP-ORB-INSTRUCTION-BUDGET`):

> "...after the Wave-MVA-1 catalog growth the authenticated Vertex
> instruction hit ~49k tokens and Gemini Live closed every authenticated
> prod session with the same code=1007."

And `services/gateway/src/orb/live/instruction/instruction-budget.ts`
(header comment): the aggregate `system_instruction` sent to Vertex Live
has a real, hard budget (`INSTRUCTION_TOTAL_BYTE_BUDGET = 30_720` bytes,
~30 KB) because **Vertex closes the handshake with WS code 1007 or 1009
when the assembled `setup` envelope is too large.** There's a guard
(`enforceInstructionBudget`, wired at `routes/orb-live.ts` ~line 7995)
that trims sections in priority order when over budget, and logs either:

```
[voice.instruction.budget_ok] session=<id> bytes=<n> budget=30720
[voice.instruction.budget_overflow] ... (when trimming happened or guard errored)
```

**This is the exact same error code and reason string** as what's
currently breaking the Serbian bridge. The obvious hypothesis: an
authenticated session's system instruction (memory facts, personalization,
journey history, tool catalog, conversation history — none of which an
anonymous session carries) is intermittently pushing past this budget, OR
past some DIFFERENT/stricter limit specific to the Vertex Serbian bridge's
own connection (it's brand-new infra, WIF-based, wired same-day as this
whole investigation — see CLAUDE.md §2e-vertex-serbian-bridge, VTID-04000).

**What I could NOT check, and you should check first:**
- These budget diagnostics are plain `console.log`/`console.warn`, **not**
  `emitDiag`/OASIS events — I confirmed via a live Supabase query that
  nothing shows up in `oasis_events` for topic `%instruction.budget%` in
  the last 2 hours. **You need CloudWatch access** (`aws logs tail
  /ecs/vitana-gateway --region eu-central-1 --since 1h --filter-pattern
  "budget"` or similar — I had no AWS CLI credentials in this session to
  check `/ecs/vitana-gateway` staging logs directly) to see whether
  `budget_overflow` is actually firing on the failing Serbian sessions.
  **This is the single highest-value next step** — it will directly
  confirm or rule out this whole hypothesis in one check.
- Whether the Vertex Serbian bridge's OWN connection path
  (`orb/live/upstream/vertex-serbian-bridge.ts`,
  `upstream-provider-selector.ts`'s `tryVertexBridgeRescue`) actually
  routes through this SAME `buildLiveSystemInstruction` +
  `enforceInstructionBudget` pipeline, or whether it's a separate/newer
  code path that might bypass the guard entirely (it's new code, added
  the same day as this whole investigation — VTID-04000). Trace this
  before assuming the guard is even active for this bridge.
- Whether the ~30 KB budget, tuned for the general AI-Studio/Vertex path,
  is even the right number for the NEW WIF-based Serbian-only Vertex
  project — a different GCP project could plausibly have different quota/
  limits, though this is speculative and not documented anywhere.

## 4. How to reproduce and verify — use the committed script

Do NOT rebuild this tooling from scratch — it already cost real time
twice (this session's own scratchpad tools aren't visible to you; they've
been consolidated and committed to the repo):

```
scripts/orb/verify-vertex-serbian-bridge.mjs
```

Usage:
```bash
# Anonymous (pre-login) — no credentials needed
node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=anonymous --trials=10

# Authenticated (post-login) — needs env vars, never hardcode credentials:
#   SUPABASE_ANON_KEY     — the public/publishable key (see vitana-v1/.env
#                            VITE_SUPABASE_PUBLISHABLE_KEY, NOT a secret)
#   TEST_ACCOUNT_EMAIL    — e2e-test@vitana.dev (CLAUDE.md's documented test account)
#   TEST_ACCOUNT_PASSWORD — get this from wherever it's already stored;
#                            do not guess it or invent a new one
SUPABASE_ANON_KEY=... TEST_ACCOUNT_EMAIL=e2e-test@vitana.dev \
  TEST_ACCOUNT_PASSWORD=... \
  node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --trials=10
```

This calls the exact same gateway endpoints the ORB widget's own SSE
transport calls (`session/start` → `audio-ready` → SSE `stream` →
`session/stop`) — no browser needed (this sandbox's outbound proxy cannot
complete a WebSocket upgrade against this host; a real browser session
would use WS, but the gateway treats WS and SSE identically server-side
since VTID-03471, confirmed in this investigation).

After running, cross-reference the printed `sessionId`s against
`oasis_events` (read-only Supabase query, safe — this account only reads):

```sql
select metadata->>'session_id', metadata->>'code', metadata->>'reason'
from oasis_events
where topic = 'orb.live.diag' and metadata->>'stage' = 'upstream_ws_close'
  and metadata::text like '%<session-id-fragment>%';
```

## 5. Separate bug found by accident — DO NOT TOUCH (per platform owner)

While running the anonymous comparison batch, found that the **pre-login
`_intro/maxina` flow is speaking the model's raw internal
reasoning/"thinking" trace out loud** instead of (or before) the intended
greeting — e.g. actual transcript captured: *"**Crafting Initial
Speech**\n\nI'm working on the opening speech, keeping your instructions
front and center..."* followed eventually by the real Serbian greeting.
Reproduced consistently (multiple trials, `scripts/orb/verify-vertex-serbian-bridge.mjs
--mode=anonymous`).

**The platform owner explicitly said not to touch this** in this round —
it's flagged here only so it isn't lost/re-discovered from scratch. Do not
investigate or fix it unless separately asked.

## 6. Suggested next steps, in order

1. Get CloudWatch access (or ask the platform owner to run the grep) and
   check for `[voice.instruction.budget_overflow]` / `budget_ok` log lines
   on a fresh batch of failing authenticated Serbian sessions run via the
   committed script. This single check will likely resolve the whole
   question.
2. If budget overflow IS firing: the fix is almost certainly widening the
   trim priority to be more aggressive for the Vertex Serbian bridge
   specifically, or investigating why authenticated Serbian sessions'
   aggregate instruction is bigger than other authenticated sessions'
   (compare against a working authenticated `en`/`de` Nova session's
   logged `bytes=` value for the same account).
3. If budget overflow is NOT firing (guard reports `budget_ok` on failing
   sessions): the 1007 is coming from something else entirely — trace
   `vertex-serbian-bridge.ts` and `VertexLiveClient`'s own `connect()`
   path directly (`services/gateway/src/orb/live/upstream/vertex-live-client.ts`)
   for anything that could produce a generic "invalid argument" on the
   `setup` message specifically for authenticated sessions — e.g. a field
   populated only when `session.identity`/`userId` is set (tool
   declarations gated on auth state, a generation-config field driven by
   personalization, etc.).
4. Either way, re-run the committed verification script after any fix and
   confirm a real, stable improvement over the current ~20% success rate
   before considering this done — two prior "fixes" in this chain looked
   plausible and were not.

## 7. Test account and access notes

- Test account: `a27552a3-0257-4305-8ed0-351a80fd3701` /
  `e2e-test@vitana.dev` (CLAUDE.md's documented test user). Per this
  repo's absolute rule, **reading is fine everywhere, writing is not** —
  the verification script here only starts/stops ORB voice sessions under
  this dedicated test account, which is within the documented narrow
  exception for recorded voice-session verification. Never widen its use.
- Staging gateway: `https://preview-aws-gateway.vitanaland.com`. Pushes to
  `main` auto-deploy here (VTID-04010/04014/04015 all did). Production is
  untouched by any of this.
