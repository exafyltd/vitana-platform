# Responses to sparring round 2

Re-verified live: `git -C vitana-v1 fetch origin` then `origin/main` = `a763b4f01cd35e6690c1e7f0eec522b7d34c7103` (the
head itself, not a commit "ahead of" it). On that commit `apps/mobile/package.json:36` has `"expo-document-picker": "57.0.3"`
and `:43` `"expo-video": "57.0.5"`; `apps/mobile/app.config.ts:93` defines `chatMediaPlugins()`, `:130`
`diaryCapturePlugins()`, `:153` `contactsImportPlugins()`, all pushed from `buildPlugins()` (`:73-76`);
`tests/app-config.test.ts:137-155` lists `expo-video`, `@react-native-community/datetimepicker`, `expo-contacts`,
`expo-document-picker`. Introducing commits: `git log -S'function chatMediaPlugins' -- apps/mobile/app.config.ts` →
`409359e2a` (VTID-05458, #1561, 2026-11-05); `contactsImportPlugins` and `expo-document-picker` → `b443a955b` (VTID-05459,
#1564, 2026-11-05). The partner read an older snapshot (the commit this plan was first measured on, `a41e89a0d`, plus the diary
lane), which predates those two merges; that is also why R1 showed only the diary lane.

```json
[
  {"finding_id": "R2-F1", "disposition": "rejected", "rationale": "The premise is false on current vitana-v1 origin/main a763b4f01: expo-video (package.json:43), expo-document-picker (:36), chatMediaPlugins() (app.config.ts:93), contactsImportPlugins() (:153) and their app-config.test.ts lines (:149-153) exist; they were merged by 409359e2a (#1561) and b443a955b (#1564). No depends_on is needed because both lanes are already merged. To stay correct if the base ever differs, Decision 5 now carries the provenance commits and a base rule: the builder re-checks the four packages/plugins on its base first and, only if one is missing, adds just that package and plugin in a new mediaHubPlugins() (never editing an existing plugin function); tasks.md task 3 says the same."},
  {"finding_id": "R2-F2", "disposition": "rejected", "rationale": "Same stale premise: on a763b4f01 buildConfig('development', …) registers expo-video and expo-document-picker (app.config.ts:73-76; tests/app-config.test.ts:137-155), so the read-only test passes. If the base lacked one, the new base rule in Decision 5 / tasks.md task 3 makes the lane add it and the test assert it, which is the partner's own suggested fallback."}
]
```
