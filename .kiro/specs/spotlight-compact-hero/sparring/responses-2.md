# Responses to round 2

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct. MIGRATED (spotlight-tier-b.vtid-05111.test.tsx:174) has no /autopilot rows, and <JourneyHero matches none of the counted patterns. Step 6 now adds ['/autopilot', 'AutopilotDashboard.tsx'] and ['/autopilot/audiobook', 'AutopilotDashboard.tsx'] to MIGRATED. It extends the counted patterns with <JourneyHero and <DashboardSpotlight, keeping the 1–2 card+skeleton tolerance. It adds an assertion that every dashboard file composes DASHBOARD_BENTO and passes no rail=. If the generic ScreenFrame/useSpotlightEnabled source assertions (:211-219) do not hold for AutopilotDashboard.tsx, the new rows are limited to the dashboard test so that gate still covers My Journey."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Correct. Wallet.tsx:581 renders CurrencyToggle in the hero's body slot. D6 and step 5 now state it explicitly: the Spotlight card keeps the balance, the credits line, the CurrencyToggle (body slot, as today) and the two primary actions (Add funds, Send). Buy credits, Request, Exchange, Withdraw and Spend credits become quick-action pills with the same handleWalletAction(...) calls and isIAPRestricted() guards. No control is dropped (SR-26)."
  }
]
```

## Owner correction applied in this revision (not a partner finding)

The owner corrected the design between rounds. The Spotlight card must stay a real Spotlight card:

- exactly one per screen;
- gradient artwork media, accent border, raised elevation;
- Index ring, headline and insight.

Only its size was the problem. On `dashboard` it sits top-start of the grid at about 40% of the stage
width and 2 rows tall, never full width, and at most about 45% of the stage area. Quick actions are
compact pills, and the grid fills a 1920×1080 viewport. Reference mock: `approved-blend-v2.png`.

The plan is rewritten accordingly:

- D1: the `dashboard` width becomes `full`, an existing token.
- D2: the rail is folded into the grid. This now covers My Journey's `JourneyRail`, with a test that its
  pending count and open-autopilot handler survive. This supersedes the round-1 "keep" answer to R1-F1
  and implements the partner's own second option.
- D3: the Spotlight treatment uses existing tokens. A coloured glow would need a new elevation token,
  which is flagged to the owner and not shipped.
- D4: a `grid-cols-10` bento with the card at `col-span-4 row-span-2`, plus an SR-11 dashboard exception
  in the contract.
- D5: tiles come only from existing data.
- D6: quick actions are a pill strip.
- D7, step 8: a read-only staging proportion spec (width ≤ 0.45, area ≤ 0.45, top-start, LTR and RTL,
  no empty band).
