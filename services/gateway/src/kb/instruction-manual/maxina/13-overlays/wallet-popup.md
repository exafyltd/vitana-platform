---
chapter: 13.7
screen_id: COM-WALLET_POPUP
title: Wallet Popup
tenant: maxina
module: Overlays
tab: Wallet Popup
url_path: (global overlay)
sidebar_path: Overlays: Wallet Popup (opens over any screen)
keywords: [wallet popup, wallet popup, wallet popup, overlays]
related_concepts: []
related_screens: []
---
## What it is

The **Wallet Popup** screen is a global overlay that opens on top of any screen — the Orb, drawers, popups, and quick action menus. In the navigation it sits at Overlays: Wallet Popup (opens over any screen), and Opens as an overlay over the current screen. This chapter explains what the screen contains, why a Maxina community user would open it, what they will see when they do, and how to act on what is there.

## Why it matters

Overlays are the cross-cutting UI that lets you keep your context while doing a quick action; they appear over the screen you are already on instead of taking you somewhere new. Every Maxina member arrives at this screen at some point in their first 30 days — sometimes via the Did You Know guided tour, sometimes by tapping a card on Home, sometimes by asking ORB "show me the wallet popup". Knowing why the screen exists is what stops it from feeling like noise the next time you land here.

## Where to find it

Opens as an overlay over the current screen. It is invoked from buttons or voice commands across the rest of the system; you do not navigate to it directly. If you ask ORB "open the wallet popup" the Navigator will route you straight here.

## What you see on this screen

This section is the screen-level inventory of panels, cards, buttons, and information. It is what Vitana reads aloud when a user asks "what's on this screen?". A maxina admin should expand this list with the exact components currently rendered. Until polished, expect to see the standard layout for the Overlays module: a header with the screen title, the primary content area filled with the cards or list described by the screen's purpose, and any module-specific toolbar in the sidebar or top-right. Anything truly distinctive about the **Wallet Popup** screen — counts, filters, special actions — should be enumerated here as bullet points by the admin via the Command Hub Manuals tab.

- Header: the screen title (Wallet Popup) and any quick-action buttons for this module
- Main content area: the panels or list described by the screen's purpose
- Empty state: friendly first-run copy if you have not yet engaged with this surface
- Action buttons: the primary call-to-action for this screen (often "Add", "Open", "RSVP", or "Save" depending on context)

## How to use it

1. Open the screen via the sidebar (Overlays: Wallet Popup (opens over any screen)) or by asking ORB "open wallet popup".
2. Invoked from a button, a tap on an item, or a voice command; close with the X or Escape to return to where you were.
3. If you are not sure what something on the screen means, ask ORB "what is this card?" — Vitana will read the relevant chapter section aloud.
4. To leave the screen, use the back button or open another sidebar item; nothing on this screen requires you to "save and exit" — your state is persisted automatically.
5. Many screens in the Overlays module pair with a related screen: see the related-screens list below for the next logical place to look.

## Related

- See module 13 for the other screens in **Overlays**.
- See the foundational concepts (chapter 0.x) for cross-cutting vocabulary referenced on this screen.
