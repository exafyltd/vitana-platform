# Mobile Surfaces

> The VITANA Mobile PWA organizes the entire mobile experience into 14 primary full-screen surfaces, each with a dedicated route under `/m/*`, specific navigation patterns, and context-aware input bar behavior.

## The 15 Primary Surfaces

Despite the "14 Surfaces" philosophy, the actual count is 15 distinct surfaces. Users perceive 14 core experiences.

| # | Surface | Route | Navigation | Input Bar | Phase | Description |
|---|---------|-------|------------|-----------|-------|-------------|
| 1 | **Community Feed** | `/m/community` | Bottom Nav | Optional | 2 | Social feed with sticky pills (Events, Meetups, Live, People) |
| 2 | **Events** | `/m/events` | Horizontal swipe | No | 1 | Event cards with swipe browsing |
| 3 | **Meetups** | `/m/meetups` | Horizontal swipe | No | 2 | 1:1 and small group meetups |
| 4 | **Live Rooms** | `/m/live` | Bottom Nav | Yes | 3 | Audio/video rooms, streaming |
| 5 | **Shorts** | `/m/shorts` | Vertical swipe | Yes | 3 | TikTok-style vertical content |
| 6 | **Wallet** | `/m/wallet` | Bottom Nav | No | 2 | VITA tokens, transactions |
| 7 | **Calendar** | `/m/calendar` | Bottom Nav | No | 2 | Personal schedule, bookings |
| 8 | **Health Dashboard** | `/m/health` | Bottom Nav | No | 2 | Pillars, scores, tracking |
| 9 | **Business Hub** | `/m/business` | Menu | No | 3 | Simplified KPIs, listings, monetization |
| 10 | **Discover** | `/m/discover` | Grid/List | No | 2 | Browse services, programs, workshops |
| 11 | **Profile** | `/m/profile` | Menu | No | 1 | User profile, settings (via sidebar) |
| 12 | **Notifications** | `/m/notifications` | Menu | No | 2 | Activity feed, alerts |
| 13 | **Search** | `/m/search` | Header | No | 2 | Global search across content |
| 14 | **Messages** | `/m/messages` | Bottom Nav | Yes | 3 | DMs, group chats |
| 15 | **Ticket Success** | `/m/ticket/:id` | Post-purchase | No | 1 | Ticket confirmation, QR code |

## Navigation Patterns

| Pattern | Surfaces | Gesture | Controls |
|---------|----------|---------|----------|
| **Horizontal Swipe** | Events, Meetups | Swipe left/right | Arrow buttons visible |
| **Vertical Scroll** | Shorts, Community | Swipe up/down | None |
| **Bottom Nav** | Core surfaces | Tap | 5 nav items max |
| **Header Actions** | All | Tap | Search, Menu, Back |
| **Full-Screen Overlay** | Details, Auth | Tap trigger | Close/back button |

## Community Surface Special Case

Community is a "social aggregation lens," not a standalone category. It answers: "What is happening with people right now?"

- Uses sticky filter pills: Events, Meetups, Live, People
- Pills switch content filter within `/m/community` route, **not routes**
- Scroll position resets on pill switch

## Full-Screen Overlays (7)

| Overlay | Trigger | Behavior |
|---------|---------|----------|
| Full-Screen Menu | Hamburger icon | Slide from right/left |
| Event Detail Sheet | Tap event card | Bottom sheet to full |
| Meetup Detail Sheet | Tap meetup card | Bottom sheet to full |
| Checkout Flow | "Get Tickets" / "Book" | Full-screen modal |
| Auth Overlay | Protected action | Full-screen modal |
| ORB Panel | Tap ORB button | Expandable panel |
| Share Sheet | Share action | Native + custom sheet |

## Public Share Routes (4)

| Route | Purpose | Auth |
|-------|---------|------|
| `/pub/event/:slug` | Event share page | No |
| `/pub/meetup/:slug` | Meetup share page | No |
| `/pub/profile/:handle` | Public profile | No |
| `/pub/live/:id` | Live room preview | No |

All share URLs preserve language (`?lang=de|en`) and UTM parameters.

## Bottom Navigation

- **Center**: ORB (fixed, non-customizable)
- **Default tabs**: Events, Community, Wallet, Profile
- **Customizable**: User can swap 4 surrounding tabs from 10 eligible destinations (Events, Community, Wallet, Profile, Health, Calendar, Messages, Live, Shorts, Services)

## Full-Screen Sidebar Menu

Accessible via hamburger icon, sliding from left. Contains:
- User info with role card
- All 14 surfaces organized in sections
- Notification/Inbox badges with counts
- Language toggle (Deutsch/English)
- Settings and Log Out

## Component Architecture

Each surface has a dedicated component in `src/components/mobile/surfaces/`:
- MobileCommunityFeed, MobileEventFeed, MobileMeetupFeed, MobileLiveRooms, MobileShorts, MobileWallet, MobileCalendar, MobileHealth, MobileServices, MobileProfile, MobileNotifications, MobileSearch, MobileMessages, MobileTicketSuccess

## Longevity Reorientation Impact

Under the reorientation plan, the home surface becomes "Vitanaland" (longevity dashboard) with the Vitana Index as the hero element. Health-related surfaces move up in navigation priority. The bottom nav default changes to Vitanaland first instead of Community.

## Related Pages

- [[mobile-pwa-architecture]] -- Architecture, rules, and phased delivery
- [[maxina-orb]] -- ORB behavior across surfaces
- [[business-hub]] -- Business Hub mobile surface
- [[design-system]] -- UI patterns for mobile components
- [[screen-registry]] -- Full screen inventory

## Sources

- `raw/mobile-pwa/mobile-screen-inventory.md`
- `raw/mobile-pwa/mobile-wireframes.md`
- `raw/mobile-pwa/mobile-pwa-rules.md`
- `raw/mobile-pwa/mobile-longevity-reorientation-plan.md`

## Last Updated

2026-04-12
