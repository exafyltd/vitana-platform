# Live staging run after the deploy of 5bf91dd (2026-09-25, test account, own rows only; all rows deleted afterwards)

Driver: real ORB voice sessions over SSE (`/orb/live/session/start`, `/orb/live/stream`, `/orb/live/stream/send` with
Polly-synthesised 16 kHz speech, `/orb/live/session/stop`) and `POST /api/v1/conversation/turn` for typed turns.

| Step | Result |
|---|---|
| Voice session C states 3 facts (neighbour Petra's dog, Lisbon trip, favourite colour) | 5 facts `user_stated` + session summary (Titan V2) saved at session end |
| Voice session D, 2 min later (inside the old 5-min cache window) | "Your neighbor Petra has a dog named Bru, and you're traveling to Lisbon in November." / "Your brother's name is Luca, and you're learning to play the cello." (the latter from a session 35 min earlier) |
| Gateway log, session D | `[ORB-BRAIN-CACHE] STALE … (memory changed since build, age 164938ms) — rebuilding` (VTID-04556) |
| Gateway log, session D | `[voice.instruction.budget_ok] … bytes=34958 budget=65536` — memory kept in the prompt (VTID-04555) |
| Typed turn, new thread, turn 1 | 3 facts `user_stated` written; `meta.model_used = deepseek/deepseek-flash` (VTID-04540) |
| Voice session E asks about the typed facts | "your best friend is Jonas who lives in Hamburg, and you started a pottery class on Tuesdays" |
| Garden forget `user_favorite_color`, then voice session F asks | fact rows 0, marker 1; "I don't have that information stored" |

Before the fix (same account, 16:47–16:51 UTC): session B said "I don't have access to personal information about
family members…" with `trimmed_sections: ["bootstrap"]` and `[ORB-BRAIN-CACHE] HIT … (age 175782ms)`.
Speech recognition heard "Bruno" as "Bru" — a transcription limit, stored and recalled consistently.
