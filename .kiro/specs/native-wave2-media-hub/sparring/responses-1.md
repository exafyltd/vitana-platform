# Responses to sparring round 1

Verified against vitana-v1 `origin/main` `a763b4f01` (the plan was measured at `a41e89a0d`, before the diary,
conversation-chat and inbox-list lanes merged): `apps/mobile/package.json` has `expo-audio`, `expo-document-picker`,
`expo-image-picker`, `expo-video`; `app.config.ts` `buildPlugins()` pushes `diaryCapturePlugins()` (`:130-139`),
`chatMediaPlugins()` (`:93-95`) and `contactsImportPlugins()` (`:153-159`); `tests/app-config.test.ts:137-155` asserts them.
The findings are right and the situation is wider than they state: `expo-video` and `expo-document-picker` are also
already installed and registered, so the lane adds no package and no plugin at all.

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Premise confirmed (and wider: all four packages are on main). plan.md Measured state 'Native state' bullet rewritten with the re-measured package.json and app.config.ts facts; Decision 5 now says the lane adds no package; tasks.md task 3 and requirements.md 3.1 no longer run `npx expo install`."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "Premise confirmed: buildPlugins() pushes diaryCapturePlugins(), chatMediaPlugins(), contactsImportPlugins(); the app-config test already lists them. Decision 5 no longer registers any plugin in buildPlugins(); app.config.ts, package.json, package-lock.json and tests/app-config.test.ts are removed from the lane's scope (plan block; the lane file's `paths` are trimmed in the lane's first commit, a lane-file edit on this plan branch fails Collab handoff), tasks.md and requirements.md 3.3. The unused mediaHubNative photosPermission key is dropped from the i18n task."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "The diary lane (and two others) already merged. plan.md 'Shared and hot files' and the lane file now say the lane edits none of the four shared config files and leaves diaryCapturePlugins() untouched; the diary 'second lane merges options' rule and the matching Risks item are removed."},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "Decision 5 now states that expo-audio, expo-image-picker, expo-video and expo-document-picker are reused with no additional options, and that enableBackgroundPlayback:false is acceptable because background playback is deferred with the unported global MiniAudioPlayer (Open items). tests/media/app-config-media.test.ts stays as a read-only guard of those registrations."}
]
```
