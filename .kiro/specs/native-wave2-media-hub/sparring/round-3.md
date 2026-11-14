# Sparring round 3 — escalated

Session: `23af960b-3021-4c9e-9d4e-4416792172fe` · plan hash `89becdd3808a6afa200e04b64d80d747634fc3611f2afdb49865e7906e093ceb`

## Summary

Round 3 review. The planner rejected both R2-F1 and R2-F2 claiming that expo-video, expo-document-picker, chatMediaPlugins(), and contactsImportPlugins() all exist on origin/main at commit a763b4f01 (merged via PRs #1561 and #1564). I re-verified at the pinned commit and also ran GitHub code search on the default branch: all three searches (chatMediaPlugins, contactsImportPlugins, expo-video) returned zero hits. The planner's rejection rationale appears unsupported. Several other premises in the plan hold (overlay bus, shell calendar:open, NATIVE_ROUTES, ledger rows, diaryCapturePlugins). The core issue remains: Decision 5 says the lane adds no packages or plugins, but the packages and plugin functions it relies on do not exist at the pinned commit or, apparently, on the current default branch.

## Findings

### R3-F1 [blocker]

The revised plan's Measured state asserts that expo-video, expo-document-picker, chatMediaPlugins() (app.config.ts:93-95), and contactsImportPlugins() (app.config.ts:153-159) exist on origin/main, citing commit a763b4f01. This is unverifiable and contradicted by all available evidence. At the pinned commit (02c75006d36b54af0fa4be52d4b3501ef6251d5d): package.json lines 22-49 have no expo-video or expo-document-picker; app.config.ts lines 60-102 define only diaryCapturePlugins() with no chatMediaPlugins or contactsImportPlugins; tests/app-config.test.ts asserts exactly 7 plugins (lines 137-146). GitHub code search on the default branch returns zero hits for 'chatMediaPlugins', 'contactsImportPlugins', and 'expo-video'. Decision 5's primary path ('this lane adds none') cannot work. The 'Base rule for the builder' fallback acknowledges the possibility but claims in parentheses '(it is not on main today)' — which is false by all verifiable evidence. The plan must treat package/plugin addition as the primary path, not an unlikely fallback.

- `exafyltd/vitana-v1:apps/mobile/package.json:22` — "expo-audio": "57.0.5",
    "expo-constants": "57.0.19",
    "expo-crypto": "57.0.3",
    "expo-image-picker": "57.0.20",
    ... (no expo-video, no expo-document-picker in the entire dependencies block)
- `exafyltd/vitana-v1:apps/mobile/app.config.ts:60` — export function buildPlugins(...): PluginEntry[] {
    const plugins: PluginEntry[] = [
      'expo-router', 'expo-localization', ..., 'expo-secure-store', 'expo-apple-authentication',
    ];
    ...
    plugins.push(...diaryCapturePlugins());
    return plugins;
  }

  export function diaryCapturePlugins(): PluginEntry[] { ... }
  // file continues with LINK_PATHS, resolveLinkHosts, buildConfig — no chatMediaPlugins, no contactsImportPlugins
- `exafyltd/vitana-v1:apps/mobile/tests/app-config.test.ts:137` — expect(names({})).toEqual([
        'expo-router',
        'expo-localization',
        './modules/vitana-voice/plugin/withVitanaVoice',
        'expo-secure-store',
        'expo-apple-authentication',
        'expo-image-picker',
        'expo-audio',
      ]);

Suggestion: Rewrite Decision 5 so the primary path is: this lane installs expo-video and expo-document-picker (npx expo install), creates a mediaHubPlugins() function in app.config.ts registering their config plugins (expo-video with supportsBackgroundPlayback:false, supportsPictureInPicture:false; expo-document-picker with default options), calls it from buildPlugins(), and updates tests/app-config.test.ts. Add package.json, package-lock.json, app.config.ts and tests/app-config.test.ts back to the Shared Files list. If the planner believes those commits exist on a branch not yet merged to the pinned/default branch, state that as a depends_on prerequisite with the lane/PR names.

## Acknowledgements of earlier responses

- R2-F1: disputed — The planner claims expo-video, expo-document-picker, chatMediaPlugins(), and contactsImportPlugins() exist on origin/main at commit a763b4f01, merged by 409359e2a (#1561) and b443a955b (#1564). This cannot be verified: (1) at the pinned commit (02c75006d) these are absent from package.json, app.config.ts, and tests/app-config.test.ts (all confirmed by read_file); (2) GitHub code search on the default branch returns zero hits for 'chatMediaPlugins', 'contactsImportPlugins', and 'expo-video'. The planner's cited commits and PRs do not appear to exist in the repository as accessible from the review tooling. Re-raised as R3-F1.
- R2-F2: disputed — Same basis as R2-F1. The planner says 'on a763b4f01 buildConfig registers expo-video and expo-document-picker' but this commit's content cannot be verified and all verifiable evidence (pinned commit read_file + default branch search) shows these registrations do not exist. Re-raised as part of R3-F1.
