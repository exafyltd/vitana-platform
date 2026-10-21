# D - Mobile app intro animation (session_01BgK6pdzSDAn6tvMcqAT1H7)
- Created 2026-09-16, last updated 2026-10-08 13:25 (idle, status "need_input"); branch claude/kind-goldberg-47i7ya (both repos)

## Goal
Replace the stock-video background of the mobile app intro/splash with a branded MAXINA logo animation. After the owner redirected, scope became the Appilix native splash only.

## Done
- exafyltd/vitana-v1#1098 (in-app intro replacement with vector "ballerina" reveal): CLOSED unmerged on 2026-10-08 (verified via GitHub). Intro page still plays stock video, per owner's choice.
- Animation finished and approved by the owner on 2026-10-07: 6 spins, pastel MAXINA burst, white background start and end, exactly 5.00 s, plays once.
- GIFs delivered to the owner as files (not in repo): maxina-splash-white-1080x1920.gif (1.99 MB after rebuild) and 720x1280 (1.60 MB); first version was 2.78 MB and Appilix has a 3 MB GIF limit. Verified with Pillow and ffmpeg.
- No merged PR, VTID, migration or deploy found for the animation.

## State now
- No open PR. No repo change pending (session said it had not changed the repo for the splash).
- Waiting for the owner to upload the 1080x1920 GIF in the Appilix dashboard and report whether it is accepted (fallback: 720x1280, send exact error).
- Nothing deployed to staging or production.

## Blocked on / needs owner
- Owner uploads GIF in Appilix dashboard and reports result. Settings given: Show Splash Screen Logo off; Background Image on, Animated Image (GIF); background #FFFFFF light and dark; timeout 5 s; Block Background Loading off.
- Whether Appilix splash changes need a new app build is unknown (docs silent). Real-phone check (scaling/cropping, playback) not done.

## Next steps for Kiro
1. Wait for the owner's Appilix upload outcome. If rejected, ask for the exact error; use the 720 GIF.
2. The GIF files were sent through the session, not committed; if they are needed in a repo, ask the owner to attach them or re-render (about 2 min per the session). Unknown where source frames live (session container only).
3. If the intro page in-app is revisited, #1098 is closed; reopen only if the owner asks.
4. Nothing here needs Claude-Code-only governance, unless a repo change is made later (then normal VTID/plan sparring applies).

## Gotchas/lessons
- Owner corrections on colours were literal: blue background only after the burst; end screen pure white. Re-read requests carefully before re-rendering.
- Appilix GIF limit 3 MB; keep headroom for upload overhead.
- Earlier history (Sept 16 - Oct 6) not read in full; only the last ~60 events were inspected.
