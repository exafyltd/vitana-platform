# Design — matches-scroll-end
Detail and premises: `plan.md`. One class change in the phone tree of `vitana-v1/src/pages/MatchesPage.tsx`:

```tsx
<div
  data-testid="matches-page"
  className="p-4 md:p-6 pb-[calc(var(--appilix-bottom-nav-height,72px)_+_env(safe-area-inset-bottom,0px)_+_90px)] md:pb-6 bg-gradient-to-br … min-h-screen"
>
```

The page scrolls with the document. The fixed bottom bar (≈72 px + safe area) and the Orb (≤36 px above the bar) are
drawn over the page bottom (`AppLayout`'s `main` and `MobileAppShell`'s div are `overflow-hidden` but have no definite
height, so they clip nothing). The padding makes the scrollable height end below them. It uses the same CSS variable as
the Orb's position, so a changed bar height moves both together. `md:pb-6` restores the desktop padding (the bar is
`md:hidden`).

The `+ 90px` matches `.maxina-signin-page` (`src/index.css:878-883`). It covers the Orb's ≤36 px overhang and leaves headroom
if Appilix changes the Orb size. The code comment says so.
