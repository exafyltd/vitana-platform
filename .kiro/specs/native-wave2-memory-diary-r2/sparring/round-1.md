# Sparring round 1 — in_progress

Session: `267f8708-74fb-499d-a22a-d9b053fd9420` · plan hash `5a399c8b31ddc76ff9d2773dac96f872927435d3ae414d87058bbd74be1b8999`

## Summary

The plan is thorough and well-researched. All major premises I verified hold against the pinned code. The 7 ledger rows, their statuses, the lane mapping, the web source imports, the community-gateway active-role header gap, and the /memory/diary redirect are all accurately described. The plan correctly identifies the class-B re-implementation need and the missing `X-Vitana-Active-Role: community` header in the native gateway layer, with an adequate test plan to enforce it. One minor finding regarding new native deps requiring Expo config plugin entries for iOS permissions.

## Findings

### R1-F1 [minor]

The diary lane adds `expo-image-picker` and an expo audio recorder as new native deps to `package.json`, but the plan does not mention the required Expo config plugin entries in `app.json` / `app.config.js` for iOS permission strings. `expo-image-picker` requires `NSPhotoLibraryUsageDescription` and `NSCameraUsageDescription`; audio recording requires `NSMicrophoneUsageDescription`. Without these plugin entries, the EAS native build (even for development) will lack the permission descriptions and the OS will kill the app on first camera/microphone access.

- `exafyltd/vitana-v1:src/pages/MobileDailyDiary.tsx:3` — import { Plus, Type, Camera, Image, X, Plane } from "lucide-react";
... import { PhotoDiaryUploader } from "@/components/diary/PhotoDiaryUploader";
... import { UnifiedCaptureCard, type CaptureMode } from "@/components/capture/UnifiedCaptureCard";

Suggestion: Add a note to the diary lane that the PR must also add the `expo-image-picker` (and the chosen audio package) as Expo config plugins in `app.json` / `app.config.js` with localised permission description strings for camera, photo library, and microphone. This is required even for development EAS builds and should be covered by the `APP_PROFILE=development npm run bundle` or a dedicated config lint step.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
