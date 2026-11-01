# Sparring round 1 — in_progress

Session: `dffbaf66-2c23-4ad1-ae2a-520080973d18` · plan hash `3e547579c84e493bb8368eb81535d8211890f78b36d8a261844740642da4aa12`

## Summary

Verified 6+ premises against pinned code. The plan's claims about web source files (MobileSettings VALID_SECTIONS, MobileSupport tab infrastructure, ConnectedApps activeTab), App.tsx route locations, shapeOf() query-stripping, and partner-connections admin-role gating all hold at the pinned commit. The ledger rows I was able to read (21 of the claimed 37) all carry lane "profile-settings-support" and status "not_started" as stated. One minor finding regarding an auth-model difference for /delete-account that the plan should acknowledge.

## Findings

### R1-F1 [minor]

/delete-account is a public (no-AuthGuard) route on the web, but the plan groups it in the 'settings' lane alongside exclusively auth-guarded screens without noting the auth difference. App.tsx:847 places /delete-account in the 'Public Routes - No Auth Required' section, while every other settings-lane route (lines 1414-1465) is wrapped in <AuthGuard>. If the native settings lane scaffold assumes all its screens run inside an authenticated context (e.g., a shared auth-required layout or provider), the delete-account screen will either require auth (breaking parity) or crash when no session exists.

- `exafyltd/vitana-v1:src/App.tsx:843` — {/* Public Routes - No Auth Required */}
<Route path="/reset-password" element={<ResetPassword />} />
<Route path="/privacy" element={<PrivacyPolicy />} />
<Route path="/terms" element={<TermsOfUse />} />
<Route path="/delete-account" element={<DeleteAccount />} />
- `exafyltd/vitana-v1:src/App.tsx:1414` — <Route path="/settings" element={
  <AuthGuard>
    <ProtectedRoute requiredRole="community">
      <SettingsRouter />
    </ProtectedRoute>
  </AuthGuard>
} />

Suggestion: Add a note in the settings lane that /delete-account is a PUBLIC route (no AuthGuard on the web) and must remain accessible without authentication in the native port. If the native settings screens share an auth-required layout or Expo Router group, the delete-account route file must be placed outside that group or the screen must handle missing auth gracefully.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
