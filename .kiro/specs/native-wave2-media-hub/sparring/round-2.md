# Sparring round 2 — in_progress

Session: `23af960b-3021-4c9e-9d4e-4416792172fe` · plan hash `e0ce633c0ff5c437d87cc056245612b6a8f624dfb231278d3559f98f346101ff`

## Summary

The planner accepted all four R1 findings and the revised plan correctly addresses R1-F1 through R1-F4 for the diary lane's expo-audio and expo-image-picker packages/plugins. However, the revision introduced a new critical false premise: it claims `expo-video`, `expo-document-picker`, `chatMediaPlugins()`, and `contactsImportPlugins()` already exist on `main`, citing a commit (`a763b4f01`) that is ahead of the pinned commit and whose content cannot be confirmed even via default-branch search. At the pinned commit (and apparently on the current default branch), these packages and functions do not exist. Decision 5's assertion that the lane "adds none" and "does not touch package.json, app.config.ts, or tests/app-config.test.ts" is therefore built on a false foundation. All other verified premises hold.

## Findings

### R2-F1 [blocker]

The revised Measured state says 'apps/mobile/package.json has expo-audio 57.0.5, expo-document-picker 57.0.3, expo-image-picker 57.0.20 and expo-video 57.0.5' and 'app.config.ts buildPlugins() (:60-77) already pushes diaryCapturePlugins(), chatMediaPlugins() (:93-95: expo-video) and contactsImportPlugins() (:153-159: expo-contacts + expo-document-picker).' Both claims are false at the pinned commit. package.json (lines 22-49) contains only expo-audio and expo-image-picker; expo-video and expo-document-picker are absent. app.config.ts defines only diaryCapturePlugins(); chatMediaPlugins() and contactsImportPlugins() do not exist (confirmed by reading the full file and by default-branch search returning zero hits for both names). The tests/app-config.test.ts asserts only 7 plugins (lines 137-146), not the larger set the plan describes. The plan attributes these to commit a763b4f01 'after the conversation-chat and inbox-list lanes merged', but those lanes have not merged at the pinned commit or, apparently, on the default branch.

- `exafyltd/vitana-v1:apps/mobile/package.json:22` — "expo-audio": "57.0.5",
    "expo-constants": "57.0.19",
    "expo-crypto": "57.0.3",
    "expo-image-picker": "57.0.20",
    ... (no expo-video, no expo-document-picker)
- `exafyltd/vitana-v1:apps/mobile/app.config.ts:60` — export function buildPlugins(...): PluginEntry[] {
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

  // no chatMediaPlugins, no contactsImportPlugins
- `exafyltd/vitana-v1:apps/mobile/tests/app-config.test.ts:137` — expect(names({})).toEqual([
        'expo-router',
        'expo-localization',
        './modules/vitana-voice/plugin/withVitanaVoice',
        'expo-secure-store',
        'expo-apple-authentication',
        'expo-image-picker',
        'expo-audio',
      ]);

Suggestion: Decision 5 must be corrected: the lane DOES need to (a) install expo-video and expo-document-picker via npx expo install, (b) register their config plugins in app.config.ts (e.g. a new mediaHubPlugins() or chatMediaPlugins() function), and (c) update tests/app-config.test.ts to assert the new entries. Alternatively, if the plan truly depends on conversation-chat and inbox-list landing first, it must declare those as depends_on in the lane table and the Measured state must say 'will exist once those lanes merge' rather than 'already on main'. The Shared Files section must re-add package.json, app.config.ts, and tests/app-config.test.ts to the lane's scope.

### R2-F2 [major]

The plan's read-only guard test 'tests/media/app-config-media.test.ts asserts that buildConfig("development", …) already registers the four plugins' will fail immediately: at the pinned commit (and on the current default branch), buildConfig only registers expo-image-picker and expo-audio. expo-video and expo-document-picker are not registered. The test as described cannot pass without this lane (or a prerequisite lane) first adding those registrations.

- `exafyltd/vitana-v1:apps/mobile/app.config.ts:60` — export function buildPlugins(env: Record<string, string | undefined>, profile: Profile): PluginEntry[] {
    const plugins: PluginEntry[] = [
      'expo-router',
      'expo-localization',
      ['./modules/vitana-voice/plugin/withVitanaVoice', { profile }],
      'expo-secure-store',
      'expo-apple-authentication',
    ];
    const scheme = googleIosUrlScheme(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
    if (scheme) plugins.push(['@react-native-google-signin/google-signin', { iosUrlScheme: scheme }]);
    plugins.push(...diaryCapturePlugins());
    return plugins;
  }

Suggestion: If the lane itself registers expo-video and expo-document-picker (see R2-F1), this test can assert all four. If the lane depends on other lanes having merged first, state that clearly and make the test assert only the two new plugins this lane adds, not all four.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and the plan correctly updated Decision 5 to say the lane adds no package for expo-audio and expo-image-picker. However, the correction overcorrected: the plan now falsely claims expo-video and expo-document-picker are also already present (see R2-F1).
- R1-F2: acknowledged — Accepted and the plan correctly removed the duplicate plugin registration for expo-audio and expo-image-picker. However, the plan now falsely claims chatMediaPlugins() and contactsImportPlugins() already handle expo-video and expo-document-picker (see R2-F1).
- R1-F3: acknowledged — Accepted and correctly addressed. The Shared Files section no longer claims a merge-options rule and correctly states diaryCapturePlugins() is untouched.
- R1-F4: acknowledged — Accepted and correctly addressed. Decision 5 now notes expo-audio and expo-image-picker are reused from the diary lane with no additional options, and that enableBackgroundPlayback:false is acceptable.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
