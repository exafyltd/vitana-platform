# Serbian ORB voice — live telemetry findings (VTID-03725)

Source: `oasis_events`, Supabase project `inmkhvwdcuyhnxkgfvsb`, read-only
query (see `../commands.log` §3 for the exact query). `lang='sr'`
`vtid.live.session.start` events over the trailing 7-day window, joined to
their paired `vtid.live.session.stop` by `session_id`.

## What the query returned

20 real Serbian live-voice sessions in the window. Splitting by outcome:

- **A meaningful share landed with `turn_count: 0` (or a `turn_count` too
  low to represent a real exchange) and essentially no `audio_out`, with
  `reason`/`code`/`diagnostic` all EMPTY** — no `nova_stream_error`, no
  `"Premature close"`, nothing. The connection opened and simply never
  produced a real turn, and nothing in the stop event says why.
- **A separate, smaller subset showed the already-documented
  "premature close" shape** — `code: nova_stream_error`,
  `diagnostic: "Premature close"`, `audio_out_chunks: 0` — the known,
  named §2e failure mode that affects ~10% of sessions across ALL
  languages, not Serbian-specific.
- The remainder completed with real turns and real audio output — Serbian
  sessions are not universally broken, they fail at a materially higher
  rate than the baseline ~10% premature-close rate.

## Why this is a distinct defect from "premature close"

The documented premature-close bug (CLAUDE.md §2e) has a clean, named
discriminator: `audio_out===0` AND `code:'nova_stream_error'` AND
`diagnostic:"Premature close"`. The zero-turn Serbian rows found here do
**not** carry that signature — no error code, no diagnostic string, the
stream simply never advances past zero turns. That is a different failure
shape and needs a different fix; conflating the two would misattribute the
Serbian gap to a bug whose existing mitigation (`VERTEX_LIVE_UNAVAILABLE`
gating the reconnect onto an honest `connection_issue` signal) does not
apply here, because there is no close event to gate a reconnect from.

## Why this is plausibly a genuine Nova capability gap, not a Vitana bug

`NOVA_SONIC_SUPPORTED_LANGUAGES` in this codebase already excludes `sr`
(only `en/de/fr/es` are marked native), and AWS's own published Nova 2
Sonic language table (cited in `nova-sonic-config.ts`'s header comment:
en/fr/it/de/es/pt/hi) does not include Serbian at all — unlike `pt`, which
Nova technically accepts but answers in the wrong language (VTID-03704),
or `ru`/`pl`, which the cascade can now rescue. Serbian is the one language
in this codebase's live-voice matrix that is absent from Nova's own
documented capability list AND has no Polly voice to fall back to via the
cascade, which is consistent with — though does not by itself prove —
Nova sometimes accepting the connection but never actually engaging its
turn-taking logic for a language it was never trained/validated to speak.

## What this diagnosis does NOT claim

- It does not claim to have reproduced the failure on demand (no live Nova
  session was opened from this environment).
- It does not claim a precise failure rate — 20 sessions over 7 days is a
  real but small sample, "roughly half" is an order-of-magnitude read, not
  a measured percentage suitable for an SLO.
- It does not propose a specific fix implementation — see acceptance.md's
  AC-4 for the named next step (an idle-timeout-based extension to
  `resendGreetingIfStuckAtZeroTurns`), deliberately not built in this PR.
