# Sparring round 1 — in_progress

Session: `e22743f3-4a33-40f8-8de3-fcc3dab928a6` · plan hash `54230821716e0ad7434bf8ddf04690afde4d9663eecffad50da1292a0d02bec8`

## Summary

The plan is well-researched and its load-bearing premises hold against the codebase. The 26 discover-commerce parity rows (22 registry + 4 exclusion) match the ledger exactly, with the 12+5+9 lane partition verified. All cited file locations, line numbers, and code structures are accurate. The web source files, App.tsx routes, env.ts guards, drawer.ts IAP gate, and resolver route all exist as described. I found one minor observation but no blockers or major issues.

## Findings

### R1-F1 [minor]

The web route `/discover/ai-picks` (App.tsx:1034, rendering `AIPicksPage`) falls under the `/discover` prefix which parity-scope.json maps to `discover-commerce`, but has no parity-ledger row. After this plan flips all 26 discover-commerce rows to `native`, the `/discover/ai-picks` route would still render as Unported in the native app. While this is technically a ledger gap (not the plan's fault), the plan should note this explicitly so the executor doesn't unknowingly leave a gap in the discover cluster, and so the owner can decide whether to add a parity row or treat it as covered by `/discover?tab=suggested` (DISCOVER.AI_PICKS).

- `exafyltd/vitana-v1:src/App.tsx:1034` — <Route path="/discover/ai-picks" element={
              <AuthGuard>
                <AIPicksPage />
              </AuthGuard>
            } />
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:929` — "key": "DISCOVER.AI_PICKS",
        "web_path": "/discover?tab=suggested",
        "kind": "screen",
        "source": "registry",
        "scope": "in",
        "lane": "discover-commerce",
        "status": "not_started"
- `exafyltd/vitana-v1:scripts/native/parity-scope.json:124` — { "prefix": "/discover", "lane": "discover-commerce" }

Suggestion: Add a note in the plan (or the discover lane) acknowledging that `/discover/ai-picks` is a web route with no ledger row. Either the executor should confirm `parity-ledger.mjs --sync` doesn't create a row for it (because it's not in screens.json), or the owner should decide whether to add one. This prevents the native discover cluster from silently missing a reachable web destination.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
