# VITANA Mobile PWA - Screen Inventory

> **Philosophy**: "14 Surfaces, Not 500 Screens"  
> Every mobile experience maps to one of 14 primary full-screen surfaces.

---

## Executive Summary

| Category | Count |
|----------|-------|
| Primary Surfaces | 15 |
| Full-Screen Overlays | 7 |
| Public Share Routes | 4 |
| **Total Unique Screens** | **26** |

Users perceive 14 core experiences. Overlays and share routes extend functionality without adding navigation complexity.

---

## 1. Primary Surfaces (15)

| # | Surface | Route | Navigation | Input Bar | Description | Phase |
|---|---------|-------|------------|-----------|-------------|-------|
| 1 | **Community Feed** | `/m/community` | Bottom Nav | Optional | Social feed with sticky pills (Events \| Meetups \| Live \| People) | 2 |
| 2 | **Events** | `/m/events` | Horizontal swipe | ❌ | Event cards with swipe browsing | 1 |
| 3 | **Meetups** | `/m/meetups` | Horizontal swipe | ❌ | 1:1 and small group meetups | 2 |
| 4 | **Live Rooms** | `/m/live` | Bottom Nav | ✅ | Audio/video rooms, streaming | 3 |
| 5 | **Shorts** | `/m/shorts` | Vertical swipe | ✅ | TikTok-style vertical content | 3 |
| 6 | **Wallet** | `/m/wallet` | Bottom Nav | ❌ | VITA tokens, transactions | 2 |
| 7 | **Calendar** | `/m/calendar` | Bottom Nav | ❌ | Personal schedule, bookings | 2 |
| 8 | **Health Dashboard** | `/m/health` | Bottom Nav | ❌ | Pillars, scores, tracking | 2 |
| 9 | **Business Hub** | `/m/business` | Menu | ❌ | Simplified KPIs, listings, monetization | 3 |
| 10 | **Discover** | `/m/discover` | Grid/List | ❌ | Browse services, programs, workshops | 2 |
| 11 | **Profile** | `/m/profile` | Menu | ❌ | User profile, settings (via sidebar) | 1 |
| 12 | **Notifications** | `/m/notifications` | Menu | ❌ | Activity feed, alerts | 2 |
| 13 | **Search** | `/m/search` | Header | ❌ | Global search across content | 2 |
| 14 | **Messages** | `/m/messages` | Bottom Nav | ✅ | DMs, group chats | 3 |
| 15 | **Ticket Success** | `/m/ticket/:id` | Post-purchase | ❌ | Ticket confirmation, QR code | 1 |

### Navigation Notes
- **Community Sticky Pills**: Community surface includes sticky filter pills (Events | Meetups | Live | People) that filter content without changing routes
- **Profile via Sidebar**: Profile is accessible via the full-screen sidebar menu, not the bottom nav
- **Business Hub**: Simplified mobile version of desktop Business Hub with essential KPIs and quick actions
- **Input Bar Column**: ✅ = always visible, Optional = context-dependent, ❌ = not shown

---

## 2. Full-Screen Overlays (7)

| # | Overlay | Trigger | Content | Behavior |
|---|---------|---------|---------|----------|
| 1 | **Full-Screen Menu** | Hamburger icon | Navigation, settings, logout | Slide from right |
| 2 | **Event Detail Sheet** | Tap event card | Full event info, tickets, RSVP | Bottom sheet → full |
| 3 | **Meetup Detail Sheet** | Tap meetup card | Meetup details, join options | Bottom sheet → full |
| 4 | **Checkout Flow** | "Get Tickets" / "Book" | Payment, confirmation steps | Full-screen modal |
| 5 | **Auth Overlay** | Protected action | Login/signup inline | Full-screen modal |
| 6 | **ORB Panel** | Tap ORB button | Voice/text AI assistant | Expandable panel |
| 7 | **Share Sheet** | Share action | Platform share options | Native + custom sheet |

### Overlay Rules (from mobile-pwa-rules.md)
- All overlays must be full-screen on mobile (`fixed inset-0`)
- Use `MobileFullScreenSheet` wrapper component
- Desktop-style centered modals are **NOT** permitted on mobile

---

## 3. Public Share Routes (4)

| # | Route | Purpose | Auth Required |
|---|-------|---------|---------------|
| 1 | `/pub/event/:slug` | Event share page | No |
| 2 | `/pub/meetup/:slug` | Meetup share page | No |
| 3 | `/pub/profile/:handle` | Public profile | No |
| 4 | `/pub/live/:id` | Live room preview | No |

### URL Structure
- All share URLs preserve language: `?lang=de|en`
- UTM parameters passed through: `utm_source`, `utm_medium`, etc.
- Auth flow preserves `redirectTo` for post-login return

---

## 4. Phased Delivery

### Phase 1: Foundation (MVP)
| Surface/Component | Priority | Notes |
|-------------------|----------|-------|
| Events (`/m/events`) | P0 | Core horizontal browse |
| Ticket Success (`/m/ticket/:id`) | P0 | Post-purchase flow |
| Event Detail Sheet | P0 | Full event info overlay |
| Auth Overlay | P0 | Inline authentication |
| Profile (`/m/profile`) | P1 | Basic profile view |
| MobileLayout wrapper | P0 | Bottom nav, safe areas |
| MobileFullScreenSheet | P0 | Shared overlay component |

### Phase 2: Social & Commerce
| Surface/Component | Priority | Notes |
|-------------------|----------|-------|
| Community Feed | P1 | Social feed |
| Meetups | P1 | Horizontal browse |
| Wallet | P1 | Token balance, transactions |
| Calendar | P1 | Personal schedule |
| Health Dashboard | P2 | Pillar scores |
| Services Hub | P2 | Browse services |
| Notifications | P2 | Activity feed |
| Search | P2 | Global search |

### Phase 3: Live & Media
| Surface/Component | Priority | Notes |
|-------------------|----------|-------|
| Live Rooms | P2 | Audio/video streaming |
| Shorts | P2 | Vertical video feed |
| Messages | P2 | DMs, group chats |
| ORB Panel | P2 | AI assistant integration |

### Phase 4: Polish & Optimization
| Focus | Notes |
|-------|-------|
| Performance tuning | Lazy loading, preloading |
| Animation polish | Framer Motion refinements |
| Accessibility | Screen reader, contrast |
| PWA features | Offline, push notifications |

---

## 5. Component Architecture

```
src/components/mobile/
├── MobileLayout.tsx              # Main wrapper with bottom nav
├── MobileFullScreenSheet.tsx     # Full-screen overlay wrapper
├── MobileBottomNav.tsx           # Bottom navigation
├── MobileHeader.tsx              # Top header with search/menu
├── HorizontalCarousel.tsx        # Embla-based horizontal scroll
├── VerticalFeed.tsx              # Vertical scroll feed
├── OrbPill.tsx                   # Collapsed ORB for live mode
├── OrbPanel.tsx                  # Expanded ORB panel
│
├── surfaces/
│   ├── MobileCommunityFeed.tsx   # Surface 1
│   ├── MobileEventFeed.tsx       # Surface 2
│   ├── MobileMeetupFeed.tsx      # Surface 3
│   ├── MobileLiveRooms.tsx       # Surface 4
│   ├── MobileShorts.tsx          # Surface 5
│   ├── MobileWallet.tsx          # Surface 6
│   ├── MobileCalendar.tsx        # Surface 7
│   ├── MobileHealth.tsx          # Surface 8
│   ├── MobileServices.tsx        # Surface 9
│   ├── MobileProfile.tsx         # Surface 10
│   ├── MobileNotifications.tsx   # Surface 11
│   ├── MobileSearch.tsx          # Surface 12
│   ├── MobileMessages.tsx        # Surface 13
│   └── MobileTicketSuccess.tsx   # Surface 14
│
├── overlays/
│   ├── MobileMenu.tsx            # Full-screen menu
│   ├── EventDetailSheet.tsx      # Event detail overlay
│   ├── MeetupDetailSheet.tsx     # Meetup detail overlay
│   ├── CheckoutFlow.tsx          # Payment flow
│   ├── AuthOverlay.tsx           # Inline auth
│   └── ShareSheet.tsx            # Share options
│
└── cards/
    ├── EventCard.tsx             # Event card for carousel
    ├── MeetupCard.tsx            # Meetup card
    ├── LiveRoomCard.tsx          # Live room preview
    └── ShortCard.tsx             # Short video thumbnail
```

---

## 6. Visual Architecture

```mermaid
graph TB
    subgraph "Entry Points"
        A[vitanaland.com] --> B{Has /m/ prefix?}
        C[Share Link] --> D[/pub/*]
    end

    subgraph "Mobile Routes /m/*"
        B -->|Yes| E[MobileLayout]
        E --> F[Bottom Nav]
        E --> G[Header]
        E --> H[Surface Content]
    end

    subgraph "14 Primary Surfaces"
        H --> S1[Community]
        H --> S2[Events]
        H --> S3[Meetups]
        H --> S4[Live Rooms]
        H --> S5[Shorts]
        H --> S6[Wallet]
        H --> S7[Calendar]
        H --> S8[Health]
        H --> S9[Services]
        H --> S10[Profile]
        H --> S11[Notifications]
        H --> S12[Search]
        H --> S13[Messages]
        H --> S14[Ticket Success]
    end

    subgraph "Overlays"
        S2 -->|Tap| O1[Event Detail Sheet]
        O1 -->|Get Tickets| O2[Checkout Flow]
        O2 -->|Need Auth| O3[Auth Overlay]
        O2 -->|Success| S14
    end

    subgraph "ORB Modes"
        E --> ORB[ORB Button]
        ORB -->|browse| P1[Panel + Mic]
        ORB -->|action| P2[Suggestions]
        ORB -->|live| P3[Text-Only Pill]
    end
```

---

## 7. Navigation Patterns

| Pattern | Surfaces | Gesture | Controls |
|---------|----------|---------|----------|
| **Horizontal Swipe** | Events, Meetups | Swipe left/right | Arrow buttons visible |
| **Vertical Scroll** | Shorts, Community | Swipe up/down | — |
| **Bottom Nav** | Core surfaces | Tap | 5 nav items max |
| **Header Actions** | All | Tap | Search, Menu, Back |
| **Full-Screen Overlay** | Details, Auth | Tap trigger | Close/back button |

---

## 8. Implementation Checklist

### Phase 1 Status
- [ ] `MobileLayout.tsx` - Main wrapper
- [ ] `MobileFullScreenSheet.tsx` - Overlay wrapper
- [ ] `MobileBottomNav.tsx` - Navigation
- [ ] `MobileEventFeed.tsx` - Events surface
- [ ] `EventDetailSheet.tsx` - Event overlay
- [ ] `CheckoutFlow.tsx` - Payment flow
- [ ] `AuthOverlay.tsx` - Inline auth
- [ ] `MobileTicketSuccess.tsx` - Ticket confirmation
- [ ] `MobileProfile.tsx` - Profile surface
- [ ] Route configuration in App.tsx

### Performance Gates
- [ ] Route-level code splitting for all `/m/*` routes
- [ ] Skeleton loaders on all content surfaces
- [ ] Media preload: next 1 item only
- [ ] Speak → filter latency < 600ms
- [ ] Tested on Pixel 4a class device

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2024-12-25 | Initial inventory from Implementation Plan v2 | — |
