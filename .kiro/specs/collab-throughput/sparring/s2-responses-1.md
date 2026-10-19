# Responses — session 2, round 1 (session 1df87f89)

```json
[
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "main() now runs its whole body, argument parsing included, inside one try/catch, and reads --comment-file first. A Usage error therefore writes the comment file and still exits 2. A test covers a missing --dir."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "Change B now guards live.rounds[n-1]?.review: when absent, step() sends nothing and returns responses_invalid with 'no_review_to_answer: round <n> has no findings to answer', never indexing .findings. A test covers a prior round without a review."},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "Removed the concurrency cap from D. A held round request has no durable state before the pass, so a long queue wait could orphan the pass with no recoverable record. A durable pending-round state is out of proportion for this plan. Cost per pass is #4189's prompt caching and per-session budget. Push bursts are an operating rule. D keeps only the throttle message, and the T5 task, lane paths and Jest list are trimmed to match."},
  {"finding_id": "R1-F5", "disposition": "accepted", "rationale": "Change A now feeds consider() candidates in a fixed order (main, then branch refs sorted lexically), so ties on updated resolve deterministically regardless of git log order. The fixture gains two branches with identical updated to pin the branch column."}
]
```
