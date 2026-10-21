# Plan sparring record — VTID-05026 (Phase 1 of the Audiobook voice plan)

- Plan: `docs/validation/VTID-04893/plan-sparring.md`, "Version 2 (final)", section "Phase 1 — scope".
- Sparring record: `plan_sparring_sessions.id = 96e42753-2ca3-4223-9df4-e0b3f93642df` (verdict `converged`).
- Final plan hash: `610ad44602766ea9b8669fc0ab010b195843c888fb604f75c2b9d7c0b4156852` (allocated with `p_sparring_id` + `p_plan_hash`).
- Owner approval: "Yes approved", 2026-10-05 (session_01LRqEtGSPKaEEJPnJDjm3ZB). Phase 1 instructed 2026-10-08 and remaining choices delegated 2026-10-10 ("Make the decisions yourself and move on") in session_019nAbKEye1ewjSuFeh8vR15.
- No new sparring round: the work stays inside the approved Phase 1 scope. The full plan, every round and the verdict are in the VTID-04893 record above.

## Decisions taken (inside the approved plan)
1. **Google voices:** `ru-RU-Chirp3-HD-Aoede` and `sr-RS-Chirp3-HD-Aoede` — the same Vitana voice in both languages, the Chirp 3 HD tier, female per Google's own `voices.list` (2026-10-10). The owner's message carried placeholders for the voice names and then delegated the pick. Re-pinning is a one-line change in `audiobook-voices.ts`; the audition list is `GET /api/v1/voice/preview/google-voices?lang=ru|sr`.
2. **Failure behaviour:** the plan's default — 422 `narration_unavailable`, never another voice (Russian does not fall back to Tatyana after a Google failure).
3. **Cap value:** 1,040,000 characters per task per UTC day on staging (the plan's proposed starting value).
4. **Phase 0 gate:** fresh staging tasks on 2026-10-10 still failed the token exchange with `iam.serviceAccounts.getAccessToken` denied. A read-only look at the service account's IAM policy showed `roles/iam.workloadIdentityUser` held only by the IAM user `claude-code-aws-agent`; the task-role binding the owner reported was not on `vitanaland@project-da3eb05a-c86e-47cb-85f`. With the owner's delegation, the binding the plan specifies (Phase 0, step 2) was added, etag-guarded, all other bindings unchanged:
   `principalSet://iam.googleapis.com/projects/20926255361/locations/global/workloadIdentityPools/vitana-aws-pool/attribute.aws_role/arn:aws:sts::472838866351:assumed-role/vitana-ecs-task-role`.
5. **`POST /voice/preview` with `google_tts`:** limited to `ru`/`sr` as the plan states; for other languages it now answers 400 (that path could not authenticate on ECS anyway). Its old tests were rewritten to the new contract.
6. **Staging wiring:** the three values ride on `connected-apps.json` (the established VTID-03788 pattern) because the register step is at GitHub's 20,000-character limit.
7. **VTID-04873 staging spec:** its Serbian assertion changes from "honest 422" to "200 in Serbian", because Serbian now has a voice.
