# Real browser screenshots — for the first time on this surface

Unlike every prior PR on the Command Hub Operator Console rename surface,
this evidence pack contains **real screenshots from an actual running
browser**, not source-level assertions alone. This session still has no
Command Hub admin login for `preview-aws-gateway.vitanaland.com`
(unchanged limitation — see `../../VTID-03960/outputs/README.md`), but the
rename bug is 100% client-side DOM/state logic with zero network calls, so
it was reproducible without a live gateway session: `services/gateway/src/
frontend/` was served with a plain static HTTP server, the real,
unmodified `app.js` was loaded in a headless Chromium via Playwright, and
`state.authToken`/`state.operatorThreads` were seeded directly to skip
past the (unrelated) auth-gated boot sequence straight to the Operator
Console UI.

- `repro-fixed-01-active-rename-open.png` — after a real double-click on
  the active thread's sidebar-row title: both the sidebar-row input and
  the title-bar input are open simultaneously, neither closed itself.
- `repro-fixed-02-active-rename-typed.png` — mid-typing into the focused
  instance; both inputs still open (the unfocused duplicate shows the
  pre-edit value until the next re-render syncs it — a known, pre-existing
  cosmetic quirk of having two DOM inputs backed by one piece of state
  that isn't live-synced on every keystroke by design; not the reported
  bug and not fixed here).
- `repro-fixed-03-active-rename-committed.png` — after Enter: the title
  bar reads "Renamed active thread via dblclick" and the sidebar row shows
  the same new title.

Full reproduction and fix-confirmation transcript: `../commands.log`.
