# Mobile PWA Architecture

> The VITANA Mobile PWA follows a "14 Surfaces, Not 500 Screens" philosophy, delivering a full-screen, mobile-first experience with ORB-driven AI interaction, a floating input bar, and strict mandatory rules.

## Core Philosophy: 14 Surfaces, Not 500 Screens

Every mobile experience maps to one of 14 (technically 15) primary full-screen surfaces. Users perceive 14 core experiences; overlays and share routes extend functionality without adding navigation complexity.

| Category | Count |
|----------|-------|
| Primary Surfaces | 15 |
| Full-Screen Overlays | 7 |
| Public Share Routes | 4 |
| **Total Unique Screens** | **26** |

The 15 primary surfaces are: Community Feed, Events, Meetups, Live Rooms, Shorts, Wallet, Calendar, Health Dashboard, Business Hub, Discover, Profile, Notifications, Search, Messages, and Ticket Success.

## ORB States

The MAXINA ORB operates in three modes, managed by a centralized `orbMode` state in `StreamingStateContext`:

| Mode | Trigger | Mic | UI |
|------|---------|-----|-----|
| `browse` | Default on feeds/players | Allowed | Floating ORB button + panel |
| `action` | Autopilot suggestion | Allowed | Panel with suggestion cards |
| `live` | Enter Live Room | Blocked | Collapsed pill (text-only) |

**State machine transitions:**
- `browse <-> action` (free transition)
- `browse -> live` and `action -> live` (entering live room)
- `live -> browse` (exiting live room)
- `live -> action` is **NOT ALLOWED** (must exit live first)

The ORB never steals the mic in Live Rooms without explicit user confirmation. When in live mode, it visually indicates voice is disabled with muted/grayed color, a "Text only" badge, and opens text input on tap rather than mic.

## Floating Input Bar

A context-aware floating input bar provides text-based interaction as an alternative to ORB voice input. It sits 16px above the bottom navigation with a frosted glass effect (`bg-gray-800/60 backdrop-blur-md`).

**Visibility by surface:**
- Always visible: Live Rooms, Messages, Shorts
- Optional: Community
- Hidden: Events, Wallet, Profile, Health, Business, Calendar, Discover

The input bar routes to the same ORB processing pipeline as voice, enabling "type to filter" with identical logic to "speak to filter."

## Layer Order (z-index Hierarchy)

| Layer | z-index | Component |
|-------|---------|-----------|
| Content | z-10 | Scrollable surface content |
| Header | z-30 | Floating header bar |
| Input Bar | z-40 | Floating input (context-aware) |
| Bottom Nav | z-50 | Navigation bar (always visible) |
| ORB Panel | z-60 | Expanded listening state |
| Overlays | z-70 | Full-screen sheets, modals |

## Mandatory Rules

1. **Full-Screen Overlay Rule**: All popups, dialogs, sheets must be full-screen on mobile (`fixed inset-0`). Use `MobileFullScreenSheet`. No desktop-style centered modals.
2. **Hybrid Browsing Model**: Events/Meetups use horizontal swipe; Shorts use vertical swipe. Horizontal must support both gestures and visible arrow controls.
3. **Share System**: Preserve language (`?lang=de|en`) in all share URLs. Public pages use `/pub/*` routes. Auth flow preserves `redirectTo`, `?lang=`, and UTM parameters.
4. **i18n (German-First)**: Auto-detect with `navigator.language.startsWith('de')`. Translation files for all 14 surfaces in `de.json` and `en.json`.
5. **Performance Non-Negotiables**: Route-level code splitting, skeleton loaders, next-1-item preload only, speak-to-filter latency <600ms, tested on mid-tier Android (Pixel 4a class).
6. **Mobile Routing**: All mobile routes use `/m/*` prefix with `MobileLayout` wrapper. Mobile surfaces must NOT reuse desktop routes.
7. **ORB Visual Parity**: Mobile ORB must use the exact same `VitanalandPortalSeed` component from desktop with all 8 visual layers preserved. No simplified mobile variant allowed.
8. **Bottom Nav Customization**: ORB permanently fixed in center. User can customize 4 surrounding tabs from 10 eligible destinations.

## Longevity Reorientation

The mobile experience is being reoriented from "social platform with health features" to a "longevity world." Key changes:
- Home surface renamed to **Vitanaland** (longevity dashboard)
- Vitana Index visible on all surfaces
- ORB elevated from feature button to longevity guide
- Entry ritual with portal animation for first-time users
- Health-related surfaces moved up in navigation priority

## Phased Delivery

- **Phase 1 (Foundation)**: Events, Ticket Success, Event Detail, Auth, Profile, MobileLayout
- **Phase 2 (Social & Commerce)**: Community, Meetups, Wallet, Calendar, Health, Discover, Notifications, Search
- **Phase 3 (Live & Media)**: Live Rooms, Shorts, Messages, ORB Panel
- **Phase 4 (Polish)**: Performance tuning, animation polish, accessibility, PWA features

## Component Architecture

```
src/components/mobile/
  MobileLayout.tsx           # Main wrapper with bottom nav
  MobileFullScreenSheet.tsx  # Full-screen overlay wrapper
  MobileBottomNav.tsx        # Bottom navigation
  HorizontalCarousel.tsx     # Embla-based horizontal scroll
  OrbPill.tsx                # Collapsed ORB for live mode
  surfaces/                  # 14 surface components
  overlays/                  # 6 overlay components
  cards/                     # Card components for carousels
```

## Related Pages

- [[maxina-orb]] -- The MAXINA ORB AI assistant
- [[mobile-surfaces]] -- The 14 mobile surfaces and their purpose
- [[design-system]] -- UI patterns and component reuse
- [[screen-registry]] -- Full screen registry (551+ screens)
- [[apple-compliance]] -- Apple App Review compliance

## Sources

- `raw/mobile-pwa/mobile-pwa-rules.md`
- `raw/mobile-pwa/mobile-screen-inventory.md`
- `raw/mobile-pwa/mobile-wireframes.md`
- `raw/mobile-pwa/mobile-longevity-reorientation-plan.md`

## Last Updated

2026-04-12
