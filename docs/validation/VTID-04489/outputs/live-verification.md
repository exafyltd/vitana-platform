# Live verification — 2026-09-24

Normaliser on every real `activity_type` value: laufen→running,
Schritte/steps/Spaziergang/Walking→walking, Krafttraining→strength,
Fahrrad gefahren→cycling, paddle lesson/Padel-Tennis→racket,
Pilates Reformer/stretching→yoga_pilates, Workout/gartenarbeit→workout.

Members with activity in the last 30 days (viewed as the test account):
one member 18 guided journey sessions (30-day window); one member meals on
4 days + 1 run; others 1–2 journey sessions / water / meals. Test account
itself: no drivers (nothing logged) → the UI shows its fallback.

First apply ranked a pillar that did not move (1 water log) above one that
fell (2 journey sessions) because it ordered by raw delta; re-applied with
"rising first, then count" and re-checked: journey (2) now ranks first.

Data reality: 0 members logged anything in the last 7 days, 3 in the last
30; no weight data exists anywhere, so weight loss cannot be a driver yet.
