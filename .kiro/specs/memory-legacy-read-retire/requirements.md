# Requirements — memory-legacy-read-retire
- R1. An identified ORB memory read goes through `recall()` only; a not-ok recall returns `ok:false` with no items and runs no legacy query.
- R2. The recall shadow no longer runs on any gateway.
- R3. Code used only by the legacy read or the shadow is removed; no other test is skipped or loosened.
- R4. Before merge, the 14-day production count of not-ok recalls is measured read-only and recorded in `docs/validation/<VTID>/`.
