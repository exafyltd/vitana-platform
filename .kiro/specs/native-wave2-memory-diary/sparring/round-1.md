# Sparring round 1 — in_progress

Session: `789653a6-dff1-4e28-960c-6e34ad0506a7` · plan hash `d3a0f1315659c0af01e7f426ea6687c78e564c58ac7250863bae141990552e96`

## Summary

The plan is coherent and most factual premises check out: the 5 web routes exist in App.tsx, /memory/diary redirects to /daily-diary on mobile, parity-scope.json already maps /memory and /daily-diary to lane memory-diary, and the cluster's data modules (memory-api, diary-index-sync, PhotoDiaryUploader) all import community-gateway or supabase/client directly, supporting the class-B determination. The two-lane partition is clean. However, I found a substantive parity-target contradiction: the 4 memory screens (Memory, Timeline, Recall, Permissions) render the desktop AppLayout/SubNavigation chrome on phones — they have NO useIsMobile() ≤1024px branch and do NOT use MobileAppShell. The plan's stated parity target ("mirror the useIsMobile() ≤ 1024 px branch" + "mobile web screens" + screenshot parity vs 390×844) is therefore not supportable against the actual web source, and the plan must decide what "mobile web parity" means for these desktop-authored pages. I also could not fully confirm the exact 7 ledger row keys/paths and the claimed 435-row count within the read budget (version 2 confirmed).

## Findings

### R1-F1 [major]

The plan asserts each native screen mirrors "the useIsMobile() <= 1024px branch of its source" and targets "mobile web screens," but the 4 memory-lane source pages (Memory.tsx, Timeline.tsx, Recall.tsx, Permissions.tsx) have no useIsMobile() branch at all and render desktop chrome (AppLayout + SubNavigation + ScreenFrame/spotlight) on phones. Only MobileDailyDiary uses MobileAppShell. So there is no "mobile web screen" to mirror for 4 of the 7 rows, and the stated screenshot-parity target (390×844 staging web) would show the responsive desktop AppLayout, not a native-phone shell.

- `exafyltd/vitana-v1:src/pages/memory/Timeline.tsx:14` — import AppLayout from "@/components/AppLayout"; import SubNavigation from "@/components/SubNavigation"; ... import { ScreenFrame } from "@/components/layout/spotlight"; ... if (spotlight) { return (<AppLayout>
- `exafyltd/vitana-v1:src/pages/memory/Permissions.tsx:9` — import AppLayout from "@/components/AppLayout"; import SubNavigation from "@/components/SubNavigation"; ... import { ScreenFrame } from "@/components/layout/spotlight";
- `exafyltd/vitana-v1:src/pages/Memory.tsx:11` — import AppLayout from "@/components/AppLayout"; import SubNavigation from "@/components/SubNavigation";
- `exafyltd/vitana-v1:src/pages/memory/Recall.tsx:3` — import AppLayout from "@/components/AppLayout"; import SubNavigation from "@/components/SubNavigation";

Suggestion: State explicitly what the parity target is for the 4 memory screens: either (a) port the body content and compose it through the native N3 shell (MobileAppShell-rendered, as the native app substitutes for the responsive AppLayout), acknowledging there is no distinct "mobile web" source for these, or (b) re-verify against the actual desktop-authored pages. Clarify the screenshot-parity reference (any 390×844 web capture of these pages will show AppLayout desktop nav, which cannot match a native shell). This ambiguity should be resolved before lane implementation.

### R1-F2 [minor]

The claimed measured state — "435 rows total", 7 rows exactly with lane memory-diary, and the precise 7 row keys (MEMORY.OVERVIEW/TIMELINE/RECALL/PERMISSIONS/DAILY_DIARY/DIARY/DIARY_BUGS) and their web paths — could not be independently confirmed against the ledger within this review (ledger version 2 confirmed, but the specific memory-diary rows were not read in full). In particular whether `/memory/diary` itself is tracked as a separate ledger row (it is a live /memory-prefixed route that redirects) was not verified, which bears on the "0 orphan" claim.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1` — version": 2 ... Rows are added by `node scripts/native/parity-ledger.mjs --sync`; scope/lane come from scripts/native/parity-scope.json.
- `exafyltd/vitana-v1:src/App.tsx:1615` — <Route path="/memory/diary" element={<AuthGuard><DiaryRouter /></AuthGuard>} />

Suggestion: Before convergence, confirm the 7 memory-diary rows (keys + web_path) and the total row count directly in the committed ledger, and confirm `/memory/diary` is not an orphaned memory-diary row (it resolves to /daily-diary on mobile and to the desktop Diary hub on desktop, which the plan says is not a cluster row).

### R1-F3 [minor]

The plan's class-B reasoning cites community-gateway for the auth token, noting memory-api/diary-index-sync import communityFetch. The native re-implementation must reproduce the gateway auth model: communityFetch sends a Bearer access token + X-Vitana-Active-Role: community header (community-gateway.ts:13-15) using the cached access token, whereas the native gateway.ts helper (getGateway/gatewayGet) goes through createGatewayFetch/getAccessToken from ports. The plan does not spell out that the class-B data paths must preserve the X-Vitana-Active-Role: community header on every memory/diary gateway call, which is a behaviour-relevant detail not present in the generic gatewayGet helper.

- `exafyltd/vitana-v1:src/lib/community-gateway.ts:13` — const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Vitana-Active-Role": "community", };
- `exafyltd/vitana-v1:apps/mobile/src/auth/gateway.ts:6` — import { createGatewayFetch, gatewayJson, type GatewayFetch } from '../ports/core'; ... export function gatewayGet<T>(path: string): Promise<T> { return gatewayJson<T>(getGateway(), path); }

Suggestion: Add an explicit requirement that the native class-B memory/diary data layer sends X-Vitana-Active-Role: community (and any other community-gateway headers) on every gateway call, and add a fake-gateway unit test asserting the header is present — otherwise native memory/diary reads/writes could hit the wrong active-role tenant scoping.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
