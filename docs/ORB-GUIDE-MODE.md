# ORB guide mode — "Ask Vitana" as the FAQ / how-to guide for a screen (VTID-04951)

**What it is.** A screen's "Ask Vitana" button opens Vitana as the guide for
what the member is looking at, instead of the daily community greeting. First
adopter: the calendar entry screen (an ended event or live room: Vitana says it
is over, the member can no longer enter, and offers to find a new one).

**How a screen adopts it** (frontend, `exafyltd/vitana-v1`):

```ts
activateOrbGuide({ feature: 'wallet_overview', state: 'empty', kind: 'vtna', title: 'Your wallet' });
```

`feature` is a snake_case id (`^[a-z0-9_]{1,40}$`), `state` one of
`upcoming | live | ended | empty | error`. `kind` and `title` are optional
(title max 80 chars). Where the loaded widget has no `startGuide`, the helper
falls back to a plain open.

**Wire.** The widget's `VitanaOrb.startGuide(ctx)` stops any open session, stashes
the context, and `_sessionStart` sends four flat one-shot fields
(`guide_feature`, `guide_state`, `guide_kind`, `guide_title`) exactly like
`support_report`. `startPayload` is rebuilt on every `_sessionStart`, so a
reconnect never re-opens the guide.

**Gateway.** `orb/live/guide/guide-context.ts` is the only place the fields are
trusted: a malformed feature or state drops the whole guide (the ORB opens
normally), a malformed kind or title is dropped, the title is flattened (no line
breaks, quotes or control characters). It is data for the model, never
instructions.

- Turn 1: the `guide_open` greeting rung (member surface only, turn 0 only,
  not anonymous). Precedence on both ladders: `support_report` > `guide_open` >
  `guided_topic` > `resume_thread`. A work surface never reaches it.
- Whole conversation: a `GUIDE MODE (FAQ)` block in the system instruction. The
  screen facts are the primary source; `search_knowledge` answers follow-up
  how-to questions; when it finds nothing, Vitana says so and offers the closest
  thing she can do.
- A guide session never claims a pooled prewarmed Nova stream (that stream was
  opened with the generic instruction and cannot take the block).

**Wording** is never written here (Part 1 rule 41). `GUIDE_STATE_HINTS` holds
English intent per `feature:state`, then per `state`. A well-formed feature
with no hint gets the generic state hint.

**To add a hint:** one entry in `GUIDE_STATE_HINTS` (e.g. `wallet_overview:empty`)
plus the `activateOrbGuide` call on that screen. No new tool, rung or route.

**Not yet:** a "What's New" card (waits for a second adopting screen); FAQ
content for the other features (each screen adds its hint when it adopts).
