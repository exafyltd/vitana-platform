# Sparring round 2 — converged

Session: `267f8708-74fb-499d-a22a-d9b053fd9420` · plan hash `42d10ff9f016c01744a16b3efd451b3a4926b5b2bc3cb7da3bc3b4b053c3f709`

## Summary

Round 2 review of the revised native-wave2-memory-diary plan. R1-F1 (Expo config plugin registration for native deps) was accepted and properly addressed in decision 3. All major premises verified against the pinned codebase: the 7 ledger rows, their statuses, the memory pages importing AppLayout (not MobileAppShell), MobileDailyDiary importing MobileAppShell, the active-role header gap in the native gateway, parity-scope.json lane mappings, and the class-B classification of memory/diary data paths. One new minor finding regarding potential microphone permission conflict with the existing vitana-voice module.

## Findings

### R2-F1 [minor]

The existing `withVitanaVoice` custom plugin (app.config.ts line 67) already sets `NSMicrophoneUsageDescription` for the ORB voice module (comment at line 64-66: 'Its microphone usage string comes from the i18n catalog at prebuild'). Decision 3 says the diary lane will add `expo-audio` or `expo-av` as a second Expo config plugin with its own `microphonePermission` string, which also writes `NSMicrophoneUsageDescription`. During Expo prebuild, if two plugins both set the same Info.plist key, one overwrites the other non-deterministically (depending on plugin execution order). The plan's unit test asserting the three iOS keys on the resolved config will not catch this, because the conflict only manifests at prebuild time (config plugin mod execution), not in the static config object.

- `exafyltd/vitana-v1:apps/mobile/app.config.ts:60` — const plugins: PluginEntry[] = [
      'expo-router',
      'expo-localization',
      // VTID-05180: the native ORB voice module. Its microphone usage string comes
      // from the i18n catalog at prebuild (fails closed without the keys); dev-only
      // local networking for the fake gateway.
      ['./modules/vitana-voice/plugin/withVitanaVoice', { profile }],
      'expo-secure-store',
      'expo-apple-authentication',
    ];

Suggestion: When adding the diary audio plugin, do NOT set its own `microphonePermission` — instead, either (a) have the diary lane's audio dependency rely on the microphone permission already set by `withVitanaVoice` (i.e. add `expo-audio`/`expo-av` as a plugin without the `microphonePermission` option, since the voice module's plugin already writes the plist key), or (b) consolidate the microphone permission string into a single source (e.g. read from the same i18n key) and set it in exactly one plugin, documenting the other plugin as depending on it. Add a prebuild-level or `expo config --type introspect` test that asserts no plist key collision.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and properly addressed. Decision 3 in the revised plan now explicitly requires registering expo-image-picker and the audio package as Expo config plugins in app.config.ts with the three iOS permission description strings, plus a unit test that resolves the config and asserts their presence. The detail about app.config.ts being the only config file (no app.json) is also correct per line 144 of the actual file.
