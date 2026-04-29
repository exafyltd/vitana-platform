---
chapter: 1.2
screen_id: COM-AUTH
title: Generic Auth
tenant: maxina
module: Public
tab: Generic Auth
url_path: /auth
sidebar_path: Public → Generic Auth
keywords: [generic auth, auth, auth, public]
related_concepts: []
related_screens: []
---
## What it is

The **Generic Auth** screen is a public-facing screen that runs before you sign in (or right after, in confirmation flows). In the navigation it sits at Public → Generic Auth, and Direct URL: `/auth`. This chapter explains what the screen contains, why a Maxina community user would open it, what they will see when they do, and how to act on what is there.

## Why it matters

This is the first impression the system makes on a new Maxina visitor; the design choices here decide whether someone bounces or commits. Every Maxina member arrives at this screen at some point in their first 30 days — sometimes via the Did You Know guided tour, sometimes by tapping a card on Home, sometimes by asking ORB "show me the generic auth". Knowing why the screen exists is what stops it from feeling like noise the next time you land here.

## Where to find it

Direct URL: `/auth`. It lives under the **Public** module of the sidebar, on the tab labelled **Generic Auth**. If you ask ORB "open the generic auth" the Navigator will route you straight here.

## What you see on this screen

This section is the screen-level inventory of panels, cards, buttons, and information. It is what Vitana reads aloud when a user asks "what's on this screen?". A maxina admin should expand this list with the exact components currently rendered. Until polished, expect to see the standard layout for the Public module: a header with the screen title, the primary content area filled with the cards or list described by the screen's purpose, and any module-specific toolbar in the sidebar or top-right. Anything truly distinctive about the **Generic Auth** screen — counts, filters, special actions — should be enumerated here as bullet points by the admin via the Command Hub Manuals tab.

- Header: the screen title (Generic Auth) and any quick-action buttons for this module
- Main content area: the panels or list described by the screen's purpose
- Empty state: friendly first-run copy if you have not yet engaged with this surface
- Action buttons: the primary call-to-action for this screen (often "Add", "Open", "RSVP", or "Save" depending on context)

## How to use it

1. Open the screen via the sidebar (Public → Generic Auth) or by asking ORB "open generic auth".
2. Most users see this screen exactly once, but the path it puts you on shapes the rest of your account.
3. If you are not sure what something on the screen means, ask ORB "what is this card?" — Vitana will read the relevant chapter section aloud.
4. To leave the screen, use the back button or open another sidebar item; nothing on this screen requires you to "save and exit" — your state is persisted automatically.
5. Many screens in the Public module pair with a related screen: see the related-screens list below for the next logical place to look.

## Related

- See module 1 for the other screens in **Public**.
- See the foundational concepts (chapter 0.x) for cross-cutting vocabulary referenced on this screen.
