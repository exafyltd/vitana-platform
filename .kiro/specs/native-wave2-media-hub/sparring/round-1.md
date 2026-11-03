# Sparring round 1 — in_progress

Session: `23af960b-3021-4c9e-9d4e-4416792172fe` · plan hash `d1a01f9ea42ae810bc99195421dc7f0063354511305c1518d7add16cc5e17404`

## Summary

The plan is thorough and well-measured in most areas, but its "Measured state" section contains a critical factual error: the diary lane (VTID-05426) has already landed in the pinned commit, so `expo-audio` and `expo-image-picker` are already in `package.json`, already registered with options in `app.config.ts` via `diaryCapturePlugins()`, and already asserted in the app-config test. Decision 5 and the Shared Files section are built on the false premise that these packages don't exist yet. This needs correction before implementation, otherwise the implementer may accidentally duplicate or overwrite the diary lane's plugin registrations.

## Findings

### R1-F1 [blocker]

The plan's measured state asserts `apps/mobile/package.json:22-48` has 'no video, audio, image-picker or document-picker package.' This is false: `expo-audio` (line 29) and `expo-image-picker` (line 32) are already present in the pinned commit. The diary lane (VTID-05426) has already merged. Decision 5 then says the lane 'adds expo-video, expo-audio, expo-image-picker and expo-document-picker with npx expo install' — but two of these four already exist. Only `expo-video` and `expo-document-picker` need to be added.

- `exafyltd/vitana-v1:apps/mobile/package.json:29` — "expo-audio": "57.0.5",
    "expo-constants": "57.0.19",
    "expo-crypto": "57.0.3",
    "expo-image-picker": "57.0.20",

Suggestion: Correct the measured state to acknowledge that expo-audio and expo-image-picker already exist (from the diary lane). Decision 5 should say the lane adds only expo-video and expo-document-picker. For the two existing packages, the lane's only concern is whether their existing plugin options in diaryCapturePlugins() need any additional configuration for media use cases (they probably don't: expo-audio already allows playback and expo-image-picker already grants photo library + camera access).

### R1-F2 [blocker]

The plan's measured state asserts `app.config.ts:60-74` registers only 'expo-router, expo-localization, withVitanaVoice, expo-secure-store, expo-apple-authentication' and claims `tests/app-config.test.ts:137-143` asserts that exact 5-plugin list with `toEqual`. Both are wrong: line 73 calls `plugins.push(...diaryCapturePlugins())` which adds expo-image-picker (with photosPermission, cameraPermission, microphonePermission) and expo-audio (with microphonePermission, enableBackgroundPlayback:false, enableBackgroundRecording:false). The test at lines 137-146 already asserts 7 plugins. Decision 5's plan to 'register each config plugin in app.config.ts buildPlugins()' for expo-image-picker and expo-audio would create a duplicate registration conflict with the existing diaryCapturePlugins() entries.

- `exafyltd/vitana-v1:apps/mobile/app.config.ts:60` — export function buildPlugins(env: Record<string, string | undefined>, profile: Profile): PluginEntry[] {
    const plugins: PluginEntry[] = [
      'expo-router',
      'expo-localization',
      ['./modules/vitana-voice/plugin/withVitanaVoice', { profile }],
      'expo-secure-store',
      'expo-apple-authentication',
    ];
    ...
    plugins.push(...diaryCapturePlugins());
    return plugins;
  }

  export function diaryCapturePlugins(): PluginEntry[] {
    ...
    return [
      ['expo-image-picker', { photosPermission: diary.photosUsage, cameraPermission: diary.cameraUsage, microphonePermission: orb.micUsageDescription }],
      ['expo-audio', { microphonePermission: orb.micUsageDescription, enableBackgroundPlayback: false, enableBackgroundRecording: false }],
    ];
  }
- `exafyltd/vitana-v1:apps/mobile/tests/app-config.test.ts:137` — expect(names({})).toEqual([
        'expo-router',
        'expo-localization',
        './modules/vitana-voice/plugin/withVitanaVoice',
        'expo-secure-store',
        'expo-apple-authentication',
        // VTID-05426 (diary lane): the Daily Diary's photo / voice capture (tests/diary/app-config-plugins.test.ts).
        'expo-image-picker',
        'expo-audio',
      ]);

Suggestion: Decision 5 must not add new expo-image-picker or expo-audio entries in buildPlugins; diaryCapturePlugins() already registers them with the correct options. The media lane only needs to add expo-video and expo-document-picker entries (with appropriate options) to buildPlugins. The plan's careful reasoning about 'never pass false for a camera or microphone option' is already correctly handled by the diary lane's diaryCapturePlugins(). The permission concern is moot for this lane.

### R1-F3 [major]

The Shared Files section states 'the native-wave2-memory-diary-r2 diary lane also adds expo-image-picker and an audio package: one plugin entry per package — the second lane to land merges options into the existing entry.' This treats the diary lane as concurrent/unmerged, but it has already landed in the pinned commit. The media lane IS 'the second lane'. Following this guidance literally (merge options into the existing entry) could lead an implementer to modify diaryCapturePlugins() options, which is cross-lane contamination. The media lane should leave diaryCapturePlugins() untouched.

- `exafyltd/vitana-v1:apps/mobile/app.config.ts:92` — export function diaryCapturePlugins(): PluginEntry[] {
    ...
    return [
      ['expo-image-picker', { photosPermission: diary.photosUsage, cameraPermission: diary.cameraUsage, microphonePermission: orb.micUsageDescription }],
      ['expo-audio', { microphonePermission: orb.micUsageDescription, enableBackgroundPlayback: false, enableBackgroundRecording: false }],
    ];
  }

Suggestion: Rewrite the Shared Files section to acknowledge the diary lane is already merged. State that expo-image-picker and expo-audio are already registered and this lane does not touch diaryCapturePlugins(). The lane adds only expo-video and expo-document-picker as new entries in buildPlugins(). The app-config test update adds these two entries only.

### R1-F4 [minor]

Decision 5 says expo-audio is needed for the native audio player (replacing HTMLAudioElement for music/podcast playback) and expo-image-picker is needed for video file selection during upload. Since both are already installed and configured by the diary lane, the media lane gets them for free — but the plan should explicitly note that no additional plugin options are needed for media use (the diary lane's existing options for expo-audio already cover playback, and expo-image-picker's existing camera/photos permissions cover video file selection).

- `exafyltd/vitana-v1:apps/mobile/app.config.ts:98` — ['expo-image-picker', { photosPermission: diary.photosUsage, cameraPermission: diary.cameraUsage, microphonePermission: orb.micUsageDescription }],
      ['expo-audio', { microphonePermission: orb.micUsageDescription, enableBackgroundPlayback: false, enableBackgroundRecording: false }],

Suggestion: Add a note in Decision 5 that expo-audio and expo-image-picker are reused from the diary lane with no additional options. Confirm that enableBackgroundPlayback:false is acceptable for media playback (the plan's open item about MiniAudioPlayer suggests background playback is deferred anyway).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
