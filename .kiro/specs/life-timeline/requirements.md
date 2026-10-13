# Requirements — Life Timeline

Source of truth: the owner-approved plan in `docs/validation/VTID-05167/plan-sparring.md` (§0 problems B1–B15,
§1 principles, §2 tiers, §3 catalog). Summary:

1. The Memory → Timeline opens on the Vitana Index: total, tier, today's change, the five pillars
   (nutrition, hydration, exercise, sleep, mental) with their change, the balance factor in plain words, and the
   weakest pillar with one action.
2. Every pillar entry shows its influence on the Index only when it was measured at recompute time
   ("+6 Exercise"); otherwise what it counted toward. Never an invented number.
3. Members see moments (one human sentence, their language), never IDs, JSON or system telemetry.
4. Everything is stored (screen visits, dwell, assistant turns) for habit learning; only spotlight/moment/digest
   tiers are shown. Internal telemetry never reaches user_activity_log.
5. Vitana reads only what the member can see and has not hidden; learning can be switched off per category.
