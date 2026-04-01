# CLAUDE.md — Project Intelligence for Vitana Platform

## Critical Rules

### 1. Always verify TypeScript build before committing gateway changes
After editing any file in `services/gateway/src/`, run:
```bash
cd services/gateway && npx tsc --noEmit 2>&1 | grep "error TS"
```
A single TS error blocks the Docker build → silently blocks ALL deploys.
This happened: missing `isAnonymous` field in WS session blocked 12+ PRs from deploying.

### 2. ORB Widget Auth Architecture (CRITICAL for future auth unification)
The ORB voice widget (`orb-widget.js`) auth is managed in ONE place only:
- **Lovable repo:** `src/hooks/useOrbVoiceWidget.ts` — the ONLY file that calls `VitanaOrb.init()`, `setAuth()`, or `destroy()`
- **Gateway repo:** `services/gateway/src/frontend/command-hub/orb-widget.js` — the widget itself

**Auth ownership rules:**
- `AuthProvider.tsx` must NEVER touch the ORB widget (no `syncOrbAuth`, no `updateAuth`, no writing `vitana.authToken`)
- Token refresh events (`TOKEN_REFRESHED`, `SIGNED_IN`) must NOT trigger ORB auth sync
- ORB auth changes only happen via `useOrbVoiceWidget` → `init({ authToken })` or `init({})` for anonymous
- Legacy pattern `syncOrbAuth()` was removed because Supabase's `autoRefreshToken` background refresh triggered it every ~60min, overriding the anonymous state on the landing page

**Widget forceAnonymous mode:**
- `init({ showFab: true })` without authToken → `forceAnonymous = true` → `setAuth()` calls ignored
- `init({ showFab: true, authToken: token })` → `forceAnonymous = false` → authenticated
- Auth change (login/logout) → `destroy()` + `init()` with correct mode
- This prevents stale Supabase sessions in localStorage from leaking identity on public pages

### 3. ORB Widget is Unified Across All Screens
One JavaScript file (`orb-widget.js`) serves ALL screens:
- Command Hub, Community landing, Community post-login, Mobile WebView
- Changes to this file affect ALL ORB communication screens
- The widget auto-detects: gateway URL (from script src), language (from `vitana.lang` localStorage)
- Auth is NOT auto-detected — must be passed explicitly via `init({ authToken })`

### 4. Anonymous vs Authenticated Sessions (Server-side)
In `orb-live.ts`, anonymous detection uses `req.identity` from the `optionalAuth` middleware:
```typescript
const hasJwtIdentity = !!(req.identity && req.identity.user_id);
const isAnonymousSession = !hasJwtIdentity;
```
- `req.identity` is ONLY set by `optionalAuth` when a valid JWT is present
- `DEV_IDENTITY` from `resolveOrbIdentity()` is NOT a real user — don't use it for the identity check
- `isDevSandbox()` returns true on Cloud Run (ENVIRONMENT=dev) — never use it for anonymous detection

### 5. Naming Convention (Vitanaland / Vitana / Maxina)
Three distinct names — never mix:
- **Vitana** = the AI companion ("My name is Vitana")
- **Vitanaland** = the platform/website (vitanaland.com) ("Welcome to Vitanaland")
- **Maxina** = the community/experience ("Join the Maxina Community")

### 6. Voice Session System Instruction Locations
- **Authenticated:** `services/gateway/src/services/ai-personality-service.ts` → `PERSONALITY_DEFAULTS.voice_live`
- **Anonymous/Presenter:** `services/gateway/src/routes/orb-live.ts` → `buildAnonymousSystemInstruction()`
- **Client context (IP geo, time):** `orb-live.ts` → `buildClientContext()` + `formatClientContextForInstruction()`

### 7. Language Priority
```
Client request (vitana.lang localStorage) > Stored preference (memory_facts) > Accept-Language > 'en'
```
Client request wins because it represents the user's LATEST UI selection. Stored preference is fallback only.

### 8. Deploy Pipeline
- AUTO-DEPLOY triggers on push to `main` when `services/gateway/**` changes
- It dispatches EXEC-DEPLOY which does Cloud Run source deploy
- `concurrency: cancel-in-progress: true` — rapid pushes cancel in-progress deploys
- VTID extraction: `BOOTSTRAP-[A-Z0-9\-]+` pattern in commit message, falls back to `BOOTSTRAP-AUTO-<sha>`
- Build: `npm run build` → `tsc` → Docker image → Cloud Run
