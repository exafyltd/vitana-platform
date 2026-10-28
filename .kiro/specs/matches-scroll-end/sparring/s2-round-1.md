# Sparring round 1 — in_progress

Session: `bab84cf4-ebd8-45c6-a879-d41183f329d4` · plan hash `2aae3bc880fbfc51fa286f544a08e086723f4a6c66522c04dd2ad70e1da36a1e`

## Summary

All five core premises verified against the pinned commit. The bug is real and the one-line fix (bottom padding on the legacy outer wrapper) is correct and well-scoped. Two minor gaps in the plan's reasoning are worth calling out; no blocker or major defect was found.

## Findings

### R1-F1 [minor]

The Orb's rendered height — the only unverified number in the clearance arithmetic — cannot be confirmed from any code in the repo, so the `4rem` buffer is sized against an unverifiable assumption.

- `exafyltd/vitana-v1:src/index.css:858` — bottom: calc(var(--appilix-bottom-nav-height, 72px) - 46px) !important;
- `exafyltd/vitana-v1:src/index.css:878` — padding-bottom: calc(
        var(--appilix-bottom-nav-height, 72px) +
        env(safe-area-inset-bottom, 0px) +
        90px
      ) !important;

Suggestion: The CSS at line 872 only specifies the Orb's `bottom` anchor — no height is defined anywhere in the repo (the Orb is Appilix-injected). The plan derives `4rem = 64px` from an observed 36 px overhang in the owner screenshot, giving only 28 px of gap. The existing `maxina-signin-page` precedent (lines 879–883) uses `+90px` for a similarly fixed overlay. Either raise the buffer to `+90px` to match that precedent and gain ~26 px of headroom against an Orb size change, or add a code comment on the chosen value citing the observed overhang so a future Appilix update doesn't silently re-clip the last card.

### R1-F2 [minor]

The plan's premise #2 explains why MobileAppShell's `overflow-hidden` div does not clip, but omits AppLayout's `main.overflow-hidden` element which is higher in the ancestor chain and equally relevant to the document-scroll claim.

- `exafyltd/vitana-v1:src/components/AppLayout.tsx:509` — <SidebarInset className="flex flex-col w-full overflow-x-hidden">
              <div className="flex flex-col h-full min-h-0 bg-background rounded-tl-2xl">
                <main className="flex-1 min-h-0 overflow-hidden">
                  <MobileAppShell>{children}</MobileAppShell>
                </main>
- `exafyltd/vitana-v1:src/components/mobile/MobileAppShell.tsx:61` — <div
          ref={contentRef}
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 32px)' }}

Suggestion: The premise that `overflow-hidden` does not clip is correct in practice (proven by users being able to scroll at all). However, the plan only explains this for the MobileAppShell div and is silent on `main.flex-1.min-h-0.overflow-hidden` at AppLayout line 511, which a reader encounters first. Add a sentence to premise #2 noting that `main` carries the same `overflow-hidden`/`min-h-0` combination, and that both elements grow with their content because no ancestor in the chain establishes a fixed (non-`min-h`) height — the outer flex container uses `min-h-screen` not `h-screen`, so no definite height is ever resolved and `overflow-hidden` clips nothing.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
