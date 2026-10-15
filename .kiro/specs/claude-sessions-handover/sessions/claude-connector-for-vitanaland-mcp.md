# Claude Connector for Vitanaland MCP (session_01GWfRFi56g7a4LyPg7C8GVT)
- Created 2026-10-06 13:51, updated 2026-10-07 15:43 (idle); branch ccr-825b9c92-moec00 (both repos)

## Goal
Make the Vitanaland Commerce MCP server ready to be listed as a connector in Anthropic's directory (OAuth via Supabase, docs/privacy pages, reviewer account), with later optional phases.

## Done
- Gateway production serves commit 230150130b09 (deployed 14:45 UTC 2026-10-07 by the exafyltd account via workflow_dispatch; not by this session). It includes 6 commits, 4 of this session's VTIDs. /alive 200; /mcp OAuth metadata correct (resource gateway.vitanaland.com/mcp, scopes email profile).
- Frontend deployed to production pinned to ece07372c43e by this session; post-deploy check passed; live bundle has /commerce/connect/privacy.
- Ledger closed: VTID-04938, 04939, 04940, 04941, 04945 (completed). Reviewer-account VTID-04958 closed.
- Reviewer account directory-reviewer@vitanatest.exafy.io created in production, registered first in service_bot_accounts and notification_test_actors, hidden from directory, fan-out check clean. The password appears in the session transcript; deliberately not copied here.
- PR numbers for these VTIDs: unknown (not read).
- Answer sheet: docs/commerce-mcp-directory-listing.md in vitana-v1; icon public/brand/vitanaland-connector-icon.png.

## State now
- Nothing known open in code; no running routines seen. Account sign-in is unproven (session did not sign in as it).

## Blocked on / needs owner
- Owner connects once from claude.ai with the reviewer account to confirm sign-in/consent/tools, then submits at claude.ai/directory/manage with the answer sheet.
- Owner must enter the reviewer credentials in the portal "Test & launch" step.

## Next steps for Kiro
1. Do nothing on the submission; it is the owner's step.
2. Optional, still open per session: phase B (tracking test backend), phase C (decision brief), What's New card for the connector. Each needs plan sparring and a VTID first.
3. If the owner reports a sign-in failure, investigate the Supabase auth user (read-only first). Production writes and deploys are Claude-Code-only.
4. If the reviewer account shows on any member-facing screen, add the exclusion (platform rules 43-45).

## Gotchas/lessons
- The session's gateway "ready for production?" message used a stale production stamp; someone else had already deployed. Check build-info (/api/v1/admin/build-info) just before asking Gate 2.
- App answers 200 for any path, so verify routes from the bundle, not status codes.
- Reviewer account is a real tenant member (membership, wallet); only exclusion lists hide it.
- Credentials were posted in the chat; treat as sensitive.
