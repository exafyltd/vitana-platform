# VITANA Mobile PWA - Final Wireframes

> **Comprehensive visual reference for all 14 mobile surfaces, ORB states, floating input bar, and overlays.**  
> **Aligned with**: `VITANA_Mobile_PWA_ORB_Approval_FINAL_2.docx`

---

## Table of Contents

1. [Global Layout Structure](#1-global-layout-structure)
2. [Layer Order Hierarchy](#2-layer-order-hierarchy)
3. [Bottom Navigation Bar](#3-bottom-navigation-bar)
4. [Full-Screen Sidebar Menu](#4-full-screen-sidebar-menu)
5. [Community Feed](#5-community-feed)
6. [Events](#6-events)
7. [Meetups](#7-meetups)
8. [Live Rooms](#8-live-rooms)
9. [Shorts](#9-shorts)
10. [Discover](#10-discover)
11. [Wallet](#11-wallet)
12. [Health Dashboard](#12-health-dashboard)
13. [Business Hub](#13-business-hub)
14. [Inbox / Messages](#14-inbox--messages)
15. [Calendar](#15-calendar)
16. [Notifications](#16-notifications)
17. [Search](#17-search)
18. [Profile](#18-profile)
19. [Ticket Success](#19-ticket-success)
20. [ORB States](#20-orb-states)
21. [Floating Input Bar](#21-floating-input-bar)
22. [Overlays](#22-overlays)

---

## 1. Global Layout Structure

```
┌────────────────────────────────────────────────────┐
│ ≡                    Status Bar              🔔    │ ← Floating header (z-30)
├────────────────────────────────────────────────────┤
│                                                    │
│                                                    │
│                                                    │
│               FULL-SCREEN CONTENT                  │ ← Main content (z-10)
│                                                    │
│                                                    │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ Type here...                     [😊] [📤]  │  │ ← Floating input (z-40)
│  └──────────────────────────────────────────────┘  │    16px above nav
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │ ← Bottom nav (z-50)
└────────────────────────────────────────────────────┘
```

### Key Principles
- **Full-screen content**: All surfaces use 100% viewport
- **Fixed navigation**: Bottom nav always visible
- **Safe areas**: iOS/Android padding respected
- **Floating input**: Context-aware, appears only on specific surfaces

---

## 2. Layer Order Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  z-70  ┌─────────────────────────────────────────────────────┐  │
│        │          OVERLAYS (Auth, Sheets, Checkout)          │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
│  z-60  ┌─────────────────────────────────────────────────────┐  │
│        │            ORB PANEL (Expanded listening)           │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
│  z-50  ┌─────────────────────────────────────────────────────┐  │
│        │      BOTTOM NAVIGATION (Always visible, fixed)      │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
│  z-40  ┌─────────────────────────────────────────────────────┐  │
│        │   FLOATING INPUT BAR (16px above nav, frosted)      │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
│  z-30  ┌─────────────────────────────────────────────────────┐  │
│        │          FLOATING HEADER (Menu, title, bell)        │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
│  z-10  ┌─────────────────────────────────────────────────────┐  │
│        │             MAIN CONTENT (Scrollable)               │  │
│        └─────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Layer Reference Table

| Layer | z-index | Component | Position |
|-------|---------|-----------|----------|
| Content | z-10 | Scrollable surface content | `relative` |
| Header | z-30 | Floating header bar | `fixed top-0` |
| Input Bar | z-40 | Floating input (context-aware) | `fixed bottom-[76px]` |
| Bottom Nav | z-50 | Navigation bar | `fixed bottom-0` |
| ORB Panel | z-60 | Expanded listening state | `fixed` |
| Overlays | z-70 | Full-screen sheets, modals | `fixed inset-0` |

---

## 3. Bottom Navigation Bar

### Default Configuration
```
┌────────────────────────────────────────────────────┐
│                                                    │
│   Events   Community    ORB    Wallet   Profile    │
│    [📅]      [👥]      (◉)     [💰]     [👤]      │
│                                                    │
└────────────────────────────────────────────────────┘
```

### ORB Center Position (Fixed)
```
┌────────────────────────────────────────────────────┐
│    Tab 1    Tab 2       ORB       Tab 3    Tab 4   │
│    [  ]     [  ]       ╭───╮      [  ]     [  ]    │
│                        │ ◉ │                       │
│                        ╰───╯                       │
└────────────────────────────────────────────────────┘
                           ↑
                    Always center
                    (non-customizable)
```

### Customizable Tab Example
```
┌────────────────────────────────────────────────────┐
│   Health   Messages    ORB    Events    Profile    │
│    [❤️]      [💬]      (◉)     [📅]      [👤]      │
└────────────────────────────────────────────────────┘
```

### Customization Rules
- **ORB**: Always center, never customizable
- **4 surrounding tabs**: User-customizable via Settings
- **Available surfaces**: All 14 surfaces can be pinned
- **Default config**: Events, Community, Wallet, Profile

---

## 4. Full-Screen Sidebar Menu

```
┌────────────────────────────────────────────────────┐
│                                              ✕     │ ← Close button
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────┐  User Name                              │
│  │ [AV] │  @handle                                │
│  └──────┘  ┌──────────────────────────────┐       │
│            │ Switch Role ▼                │       │ ← Role card (not dropdown)
│            └──────────────────────────────┘       │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  📰  Community                                     │
│  🎫  Events                                        │
│  🤝  Meetups                                       │
│  🔴  Live Rooms                                    │
│  ▶️  Shorts                                        │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  💰  Wallet                                        │
│  📅  Calendar                                      │
│  ❤️  Health                                        │
│  💼  Business Hub                                  │
│  🔍  Discover                                      │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  🔔  Notifications                         (3)    │
│  💬  Inbox                                 (2)    │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  🌐  Deutsch │ English                            │ ← Language toggle
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  ⚙️  Settings                                      │
│  🚪  Log Out                                       │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Menu Behavior
- **Entry**: Slide from left (hamburger tap)
- **Exit**: Tap ✕ or swipe left
- **Position**: `fixed inset-0` (full-screen)
- **Background**: Dark overlay with blur
- **Scroll**: Vertical scroll if content exceeds viewport
- **Role switching**: Uses card-based UI (not dropdown)
- **Badge counts**: Shown for notifications/messages

---

## 5. Community Feed

```
┌────────────────────────────────────────────────────┐
│ ≡                 Community                   🔔   │
├────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────┐ │
│ │  Events  │  Meetups  │  Live  │  People       │ │ ← Sticky filter pills
│ └────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ [Avatar]  User Name                 2h ago   │  │
│  │                                              │  │
│  │ Post content here with community updates     │  │
│  │ and social activity from members...          │  │
│  │                                              │  │
│  │ ┌──────────────────────────────────────────┐ │  │
│  │ │          [Attached Image/Video]          │ │  │
│  │ └──────────────────────────────────────────┘ │  │
│  │                                              │  │
│  │ ❤️ 24    💬 12    🔗 Share                   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ [Avatar]  Another User             30m ago   │  │
│  │ Quick update about an upcoming event...      │  │
│  │                                              │  │
│  │ ❤️ 8     💬 3     🔗 Share                   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │ ← Floating input (optional)
│  │ Type here...                    [😊] [📤]   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Community-Specific Features
- **Sticky pills**: Filter content within `/m/community` route
- **Pills only here**: No other surface has sticky pills
- **Active pill**: Primary color background
- **Scroll behavior**: Pills stick to top when scrolling down
- **Input bar**: Optional (community posting)

---

## 6. Events

```
┌────────────────────────────────────────────────────┐
│ ≡                   Events                    🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │                                              │  │
│  │                                              │  │
│  │              [EVENT IMAGE]                   │  │
│  │                                              │  │
│  │                                              │  │
│  │                                              │  │
│  │ ─────────────────────────────────────────── │  │
│  │                                              │  │
│  │ Yoga Retreat Berlin                          │  │
│  │ 📍 Berlin  •  📅 Jan 15  •  €49              │  │
│  │                                              │  │
│  │ ┌────────────────┐    ┌───┐  ┌────────┐     │  │
│  │ │  Get Tickets   │    │ ♡ │  │ Share  │     │  │
│  │ └────────────────┘    └───┘  └────────┘     │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│             ◀   •   ○   ○   ○   ▶                 │ ← Navigation dots
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Events Behavior
- **Navigation**: Horizontal swipe (snap to card)
- **Card size**: Full viewport width minus padding
- **Dots**: Position indicator + navigation
- **Arrows**: Optional side navigation (visible on hover/touch)
- **Input bar**: ❌ Not shown
- **Tap action**: Opens Event Detail Sheet

---

## 7. Meetups

```
┌────────────────────────────────────────────────────┐
│ ≡                   Meetups                   🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │              [MEETUP IMAGE]                  │  │
│  │                                              │  │
│  │ ─────────────────────────────────────────── │  │
│  │                                              │  │
│  │ Coffee & Conversation                        │  │
│  │ 👥 Small group (4 people)                    │  │
│  │ 📍 Munich  •  📅 Tomorrow  •  Free           │  │
│  │                                              │  │
│  │ ┌────────────────┐    ┌───┐  ┌────────┐     │  │
│  │ │   Join Now     │    │ ♡ │  │ Share  │     │  │
│  │ └────────────────┘    └───┘  └────────┘     │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│             ◀   •   ○   ○   ▶                     │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Meetups Behavior
- **Navigation**: Horizontal swipe (same as Events)
- **Group indicator**: Shows participant count/limit
- **Input bar**: ❌ Not shown
- **Tap action**: Opens Meetup Detail Sheet

---

## 8. Live Rooms

### Live Rooms Feed (Browse)
```
┌────────────────────────────────────────────────────┐
│ ≡                 Live Rooms                  🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │              [LIVE PREVIEW]                  │  │
│  │                                              │  │
│  │  🔴 LIVE   •   234 watching                  │  │
│  │                                              │  │
│  │ Morning Meditation with Sarah                │  │
│  │ 🎙️ Audio Room  •  Free                       │  │
│  │                                              │  │
│  │ ┌────────────────┐              ┌────────┐  │  │
│  │ │   Join Room    │              │ Share  │  │  │
│  │ └────────────────┘              └────────┘  │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│             ◀   •   ○   ○   ▶                     │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Inside Live Room (Active)
```
┌────────────────────────────────────────────────────┐
│ ✕  Morning Meditation              🔴 LIVE  234   │
├────────────────────────────────────────────────────┤
│                                                    │
│                                                    │
│              [HOST VIDEO / AUDIO]                  │
│                                                    │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 💬 Live chat scrolling...                    │  │
│  │ User1: Great session!                        │  │
│  │ User2: 🙏                                    │  │
│  │ User3: Can you talk about breathing?         │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ Type here...                    [😊] [📤]   │  │ ← Floating input (✅ visible)
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [🎤]     [📷]    ┌─────────┐   [❤️]    [🚪]    │
│                     │ORB pill │                    │ ← ORB collapsed to pill
│                     └─────────┘                    │
└────────────────────────────────────────────────────┘
```

### Live Room Special Rules
- **ORB mode**: Collapsed to text-only pill
- **Mic protection**: ORB mic disabled (room owns audio)
- **Mic switch**: Confirmation dialog required before switching
- **Input bar**: ✅ Always visible for chat
- **Room controls**: Mic, camera, reactions, leave

---

## 9. Shorts

```
┌────────────────────────────────────────────────────┐
│                                                    │
│                                                    │
│                                                    │
│                                                    │
│                                                    │
│              [FULL-SCREEN VIDEO]                   │
│                                                    │
│                                                    │
│                                                    │
│                                                    │
│                                       ┌───┐        │
│                                       │ ❤️ │        │
│                                       │256│        │
│                                       ├───┤        │
│   @creator_handle                     │ 💬 │        │
│   Caption text for the short...       │ 42│        │
│   #wellness #mindfulness              ├───┤        │
│                                       │ 🔗 │        │
│                                       └───┘        │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ Type here...                    [😊] [📤]   │  │ ← Floating input (✅ visible)
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Shorts Behavior
- **Navigation**: Vertical swipe (TikTok-style)
- **Video**: Full-screen, auto-play
- **Side actions**: Like, comment, share (vertical stack)
- **Input bar**: ✅ Visible for comments
- **Progress**: Optional thin bar at bottom of video

---

## 10. Discover

```
┌────────────────────────────────────────────────────┐
│ ≡                  Discover                   🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  🔍 Search services, programs...                   │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Featured Programs                                 │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │    [Image]      │  │    [Image]      │         │
│  │ 8-Week Wellness │  │ Sleep Mastery   │         │
│  │ €199            │  │ €149            │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Health Services                                   │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │    [Image]      │  │    [Image]      │         │
│  │ Nutrition Plan  │  │ Fitness Coach   │         │
│  │ €89/mo          │  │ €129/mo         │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Workshops                                         │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │    [Image]      │  │    [Image]      │         │
│  │ Yoga Basics     │  │ Meditation 101  │         │
│  │ Free            │  │ €29             │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Discover Behavior
- **Layout**: 2-column grid
- **Categories**: Grouped by type
- **Search**: Prominent search bar at top
- **Input bar**: ❌ Not shown
- **Scroll**: Vertical infinite scroll

---

## 11. Wallet

```
┌────────────────────────────────────────────────────┐
│ ≡                   Wallet                    🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │           ◉ VITA Balance                     │  │
│  │                                              │  │
│  │              1,234.56                        │  │
│  │                VITA                          │  │
│  │                                              │  │
│  │           ≈ €123.45 EUR                      │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │   Send   │  │  Receive │  │   Swap   │         │
│  │    ↑     │  │    ↓     │  │    ⇄     │         │
│  └──────────┘  └──────────┘  └──────────┘         │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Recent Transactions                               │
│  ┌──────────────────────────────────────────────┐  │
│  │ ↓  Received from @user      +50 VITA         │  │
│  │    2 hours ago                               │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ↑  Event ticket purchase    -25 VITA         │  │
│  │    Yesterday                                 │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ★  Reward earned            +10 VITA         │  │
│  │    2 days ago                                │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Wallet Behavior
- **Balance card**: Prominent VITA display with EUR equivalent
- **Quick actions**: Send, Receive, Swap buttons
- **Transaction list**: Chronological with icons
- **Input bar**: ❌ Not shown

---

## 12. Health Dashboard

```
┌────────────────────────────────────────────────────┐
│ ≡                   Health                    🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │              VITANA INDEX                    │  │
│  │                                              │  │
│  │                 78                           │  │
│  │              ───────────                     │  │
│  │              ╭─────────╮                     │  │
│  │              │  Good   │                     │  │
│  │              ╰─────────╯                     │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Health Pillars                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │ 💪 Movement     │  │ 🍎 Nutrition    │         │
│  │ ████████░░  80% │  │ ██████░░░░  60% │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │ 😴 Sleep        │  │ 🧘 Mindfulness  │         │
│  │ ███████░░░  70% │  │ █████████░  90% │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │ 👥 Social       │  │ 💧 Hydration    │         │
│  │ ████████░░  80% │  │ ██████░░░░  55% │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Health Dashboard Behavior
- **Vitana Index**: Central score with status
- **Pillars**: 2-column grid with progress bars
- **Tap pillar**: Opens pillar detail view
- **Input bar**: ❌ Not shown

---

## 13. Business Hub

```
┌────────────────────────────────────────────────────┐
│ ≡               Business Hub                  🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │  💰 €1,234      │  │  📈 €456        │         │
│  │  Total Earned   │  │  This Month     │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ┌─────────────────┐  ┌─────────────────┐         │
│  │  ⏳ €89         │  │  📦 12          │         │
│  │  Pending        │  │  Active Items   │         │
│  └─────────────────┘  └─────────────────┘         │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Quick Actions                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ ➕  Create Event                      →      │  │
│  ├──────────────────────────────────────────────┤  │
│  │ 📦  Add to Inventory                  →      │  │
│  ├──────────────────────────────────────────────┤  │
│  │ 🎯  Create Promotion                  →      │  │
│  ├──────────────────────────────────────────────┤  │
│  │ 📊  View Analytics                    →      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Recent Activity                                   │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎫 Ticket sold: Yoga Retreat      +€49      │  │
│  │ 📦 Resale commission              +€12      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Business Hub Behavior
- **Simplified KPIs**: 4 key metrics in 2x2 grid
- **Quick actions**: Common tasks with navigation arrows
- **Recent activity**: Latest earnings/sales
- **Input bar**: ❌ Not shown
- **Note**: Full Business Hub available on desktop

---

## 14. Inbox / Messages

```
┌────────────────────────────────────────────────────┐
│ ≡                    Inbox                    🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  🔍 Search messages...                             │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ [AV]  Sarah Miller                   2m ago  │  │
│  │       Hey! Are you coming to the ev...  ●    │  │
│  ├──────────────────────────────────────────────┤  │
│  │ [AV]  Yoga Group (5)                 1h ago  │  │
│  │       Michael: Great session today!          │  │
│  ├──────────────────────────────────────────────┤  │
│  │ [AV]  John Smith                     3h ago  │  │
│  │       Thanks for the recommendation!         │  │
│  ├──────────────────────────────────────────────┤  │
│  │ [AV]  VITANA Team                Yesterday   │  │
│  │       Welcome! Here's how to get started...  │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Conversation View
```
┌────────────────────────────────────────────────────┐
│ ←       Sarah Miller                    [···]      │
├────────────────────────────────────────────────────┤
│                                                    │
│                              ┌──────────────────┐  │
│                              │ Hey! Are you     │  │
│                              │ coming to the    │  │
│                              │ event tonight?   │  │
│                              └──────────────────┘  │
│                                           2:30 PM  │
│                                                    │
│  ┌──────────────────┐                              │
│  │ Yes! Looking     │                              │
│  │ forward to it 🎉 │                              │
│  └──────────────────┘                              │
│  2:32 PM                                           │
│                                                    │
│                              ┌──────────────────┐  │
│                              │ Great! See you   │  │
│                              │ there! 👋        │  │
│                              └──────────────────┘  │
│                                           2:33 PM  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ Type here...                    [😊] [📤]   │  │ ← Floating input (✅ visible)
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Messages Behavior
- **Inbox**: List view with avatars, previews, timestamps
- **Unread indicator**: Blue dot on unread messages
- **Conversation**: Messenger-style bubbles
- **Input bar**: ✅ Always visible in conversation view

---

## 15. Calendar

```
┌────────────────────────────────────────────────────┐
│ ≡                  Calendar                   🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  ◀  January 2025                              ▶   │
│                                                    │
│  Mo   Tu   We   Th   Fr   Sa   Su                 │
│  ┌────┬────┬────┬────┬────┬────┬────┐             │
│  │    │    │ 1  │ 2  │ 3  │ 4  │ 5  │             │
│  ├────┼────┼────┼────┼────┼────┼────┤             │
│  │ 6  │ 7  │ 8  │ 9  │ 10 │ 11 │ 12 │             │
│  ├────┼────┼────┼────┼────┼────┼────┤             │
│  │ 13 │ 14 │[15]│ 16 │ 17 │ 18 │ 19 │             │
│  ├────┼────┼────┼────┼────┼────┼────┤  [15] = today
│  │ 20 │ 21 │ 22 │ 23 │ 24 │ 25 │ 26 │             │
│  ├────┼────┼────┼────┼────┼────┼────┤             │
│  │ 27 │ 28 │ 29•│ 30 │ 31 │    │    │  • = event  │
│  └────┴────┴────┴────┴────┴────┴────┘             │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Upcoming                                          │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📅 Jan 29  •  Yoga Retreat                   │  │
│  │    10:00 AM  •  Berlin Studio                │  │
│  ├──────────────────────────────────────────────┤  │
│  │ 🤝 Jan 31  •  Coffee Meetup                  │  │
│  │    2:00 PM  •  Café Central                  │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Calendar Behavior
- **Month view**: Compact calendar grid
- **Event dots**: Indicate days with scheduled items
- **Today highlight**: Current date emphasized
- **Upcoming list**: Scrollable list of future events
- **Input bar**: ❌ Not shown

---

## 16. Notifications

```
┌────────────────────────────────────────────────────┐
│ ≡               Notifications                 🔔   │
├────────────────────────────────────────────────────┤
│                                                    │
│  Today                                             │
│  ┌──────────────────────────────────────────────┐  │
│  │ ● 🎫 Your ticket for Yoga Retreat is         │  │
│  │   confirmed!                          2h ago │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ● 👥 Sarah Miller started following you      │  │
│  │                                       4h ago │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ● ❤️ 3 people liked your post               │  │
│  │                                       5h ago │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Yesterday                                         │
│  ┌──────────────────────────────────────────────┐  │
│  │   💬 New message from John Smith             │  │
│  │                                    Yesterday │  │
│  ├──────────────────────────────────────────────┤  │
│  │   🔴 Live: Morning Meditation starting now   │  │
│  │                                    Yesterday │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Earlier                                           │
│  ┌──────────────────────────────────────────────┐  │
│  │   💰 You received 10 VITA tokens             │  │
│  │                                       2d ago │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Notifications Behavior
- **Grouped by time**: Today, Yesterday, Earlier
- **Unread indicator**: Blue dot (●) on unread items
- **Tap action**: Navigate to relevant content
- **Input bar**: ❌ Not shown

---

## 17. Search

```
┌────────────────────────────────────────────────────┐
│ ←                  Search                          │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🔍 Search events, people, services...    ✕   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Recent Searches                                   │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🕐 yoga berlin                           ✕   │  │
│  │ 🕐 meditation                            ✕   │  │
│  │ 🕐 wellness retreat                      ✕   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Trending                                          │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🔥 New Year Wellness                         │  │
│  │ 🔥 Morning Routines                          │  │
│  │ 🔥 Local Meetups                             │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Categories                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │ Events  │ │ People  │ │Services │ │ Groups  │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Search Behavior
- **Global search**: Searches across all content types
- **Recent searches**: Quick access to past queries
- **Trending**: Popular searches
- **Category filters**: Quick filter by content type
- **Input bar**: ❌ Not shown (search has its own input)

---

## 18. Profile

```
┌────────────────────────────────────────────────────┐
│ ≡                  Profile                    ⚙️   │
├────────────────────────────────────────────────────┤
│                                                    │
│            ┌────────────────┐                      │
│            │                │                      │
│            │    [Avatar]    │                      │
│            │                │                      │
│            └────────────────┘                      │
│                                                    │
│             User Name                              │
│             @handle                                │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 👤 Member    🎫 Creator    💼 Reseller       │  │ ← Role cards (tap to switch)
│  │    [Active]      [ ]          [ ]            │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Stats                                             │
│  ┌────────┐  ┌────────┐  ┌────────┐               │
│  │  124   │  │   89   │  │   45   │               │
│  │ Events │  │Followers│  │Following│              │
│  └────────┘  └────────┘  └────────┘               │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📝  Edit Profile                       →     │  │
│  ├──────────────────────────────────────────────┤  │
│  │ 🎫  My Tickets                         →     │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ❤️  Saved Items                        →     │  │
│  ├──────────────────────────────────────────────┤  │
│  │ ⚙️  Settings                           →     │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Profile Behavior
- **Role switching**: Card-based UI (not dropdown)
- **Stats**: Compact stat display
- **Quick links**: Edit profile, tickets, saved items, settings
- **Input bar**: ❌ Not shown
- **Access**: Via sidebar menu, bottom nav, or direct route

---

## 19. Ticket Success

```
┌────────────────────────────────────────────────────┐
│                                              ✕     │
├────────────────────────────────────────────────────┤
│                                                    │
│                    ✓                               │
│               Purchase                             │
│              Complete!                             │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │              ┌────────────┐                  │  │
│  │              │            │                  │  │
│  │              │  [QR CODE] │                  │  │
│  │              │            │                  │  │
│  │              └────────────┘                  │  │
│  │                                              │  │
│  │             Ticket #VIT-2025-001             │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Event Details                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎫 Yoga Retreat Berlin                       │  │
│  │ 📅 January 15, 2025 at 10:00 AM              │  │
│  │ 📍 Berlin Studio, Prenzlauer Berg            │  │
│  │ 🎟️ 1x General Admission                      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📱  Add to Wallet                            │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🔗  Share Ticket                             │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📅  Add to Calendar                          │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```

### Ticket Success Behavior
- **Confirmation**: Clear success message
- **QR code**: Scannable ticket code
- **Event details**: Summary of purchase
- **Actions**: Add to wallet, share, add to calendar
- **Input bar**: ❌ Not shown

---

## 20. ORB States

> **⚠️ VISUAL PARITY REQUIREMENT**: Mobile ORB must use the identical `VitanalandPortalSeed` component from desktop. No simplified variants allowed. See [Section 13 of Mobile PWA Rules](./mobile-pwa-rules.md#13-orb-visual-parity).

### Desktop Component Reference

```typescript
// REQUIRED: Use exact desktop component
import { VitanalandPortalSeed } from '@/components/vitanaland/VitanalandPortalSeed';

// Bottom nav (48px)
<VitanalandPortalSeed size="sm" layoutId="vitana-orb" />

// Expanded listening (80px)
<VitanalandPortalSeed size="md" audioState="listening" />
```

### Visual Architecture (All Layers Required)

```
┌─────────────────────────────────────────────────────┐
│                   OUTER HALO                        │  ← Ethereal purple gradient
│   ┌─────────────────────────────────────────────┐   │
│   │              SECOND HALO                    │   │  ← Inner glow
│   │   ┌─────────────────────────────────────┐   │   │
│   │   │           THIN RING                 │   │   │  ← Crisp edge
│   │   │   ┌─────────────────────────────┐   │   │   │
│   │   │   │        GLASS SHELL          │   │   │   │  ← Radial gradient sphere
│   │   │   │   ┌─────────────────────┐   │   │   │   │
│   │   │   │   │    NEBULA CLOUDS    │   │   │   │   │  ← 3 rotating layers
│   │   │   │   │   ┌─────────────┐   │   │   │   │   │
│   │   │   │   │   │   AURORA    │   │   │   │   │   │  ← 4 animated bands
│   │   │   │   │   │  ┌───────┐  │   │   │   │   │   │
│   │   │   │   │   │  │ CORE  │  │   │   │   │   │   │  ← Triple light core
│   │   │   │   │   │  └───────┘  │   │   │   │   │   │
│   │   │   │   │   └─────────────┘   │   │   │   │   │
│   │   │   │   └─────────────────────┘   │   │   │   │
│   │   │   └─────────────────────────────┘   │   │   │
│   │   └─────────────────────────────────────┘   │   │
│   └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
         + MICRO-FRAGMENTS (10+ floating particles)
```

### Animation Specifications (Preserved from Desktop)

| Animation | Timing | Easing |
|-----------|--------|--------|
| Breathing scale | 4s loop, 0.98–1.02 | ease-in-out |
| Nebula layer 1 | 35s rotation | linear |
| Nebula layer 2 | 45s rotation | linear |
| Nebula layer 3 | 60s rotation | linear |
| Aurora flow | 8s cycle | ease-in-out |
| Micro-fragments | Random drift, 10–20s | linear |
| Halo pulse (listening) | 2s cycle | ease-in-out |

### Browse Mode (Default)
```
┌────────────────────────────────────────────────────┐
│                                                    │
│                    Content                         │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
│                      ╭───╮                         │
│                      │ ◉ │  ← VitanalandPortalSeed │
│                      ╰───╯    size="sm" (48px)     │
└────────────────────────────────────────────────────┘
```
- **Component**: `<VitanalandPortalSeed size="sm" />`
- **Appearance**: Full 3D glass orb with all visual layers
- **Animations**: Breathing + nebula rotation + micro-fragments
- **Tap action**: Opens listening panel
- **Voice**: Enabled, ready for input
- **Filtering**: Can speak to filter feed content

### Listening Mode (Active)
```
┌────────────────────────────────────────────────────┐
│                                                    │
│              ╭───────────────────╮                 │
│              │                   │                 │
│              │    ◉ Listening    │                 │ ← Expanded panel
│              │    ~~~~~~~~~~~    │                 │    with audio waves
│              │                   │                 │
│              │ "Find yoga events │                 │
│              │  in Berlin..."    │                 │
│              │                   │                 │
│              ╰───────────────────╯                 │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```
- **Component**: `<VitanalandPortalSeed size="md" audioState="listening" />`
- **Appearance**: Expanded panel with enhanced orb glow
- **Animations**: Faster rotation, halo pulse, audio wave visualization
- **Audio waves**: Show voice input activity
- **Transcript**: Real-time text display
- **Exit**: Tap outside or ORB button

### Processing State
```
- **Component**: `<VitanalandPortalSeed size="md" audioState="processing" />`
- **Visual**: Rainbow gradient shift through orb layers
- **Animations**: Wave patterns emanating from core
```

### Error State
```
- **Component**: `<VitanalandPortalSeed size="md" audioState="error" />`
- **Visual**: Red tint flash across orb
- **Animations**: Subtle shake micro-animation
```

### Action Mode (Suggestions)
```
┌────────────────────────────────────────────────────┐
│                                                    │
│              ╭───────────────────╮                 │
│              │                   │                 │
│              │ Suggested Actions │                 │
│              │                   │                 │
│              │ ┌───────────────┐ │                 │
│              │ │ Book Yoga     │ │                 │
│              │ │ Retreat? ✓ ✕  │ │                 │
│              │ └───────────────┘ │                 │
│              │                   │                 │
│              ╰───────────────────╯                 │
│                                                    │
├────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]      │
└────────────────────────────────────────────────────┘
```
- **Suggestions**: Autopilot action cards
- **Confirm/Reject**: ✓ to confirm, ✕ to dismiss
- **Multiple actions**: Scrollable if many suggestions

### Live Mode (In Live Room)
```
┌────────────────────────────────────────────────────┐
│                                                    │
│               [LIVE ROOM CONTENT]                  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ Type here...                    [😊] [📤]   │  │ ← Floating input visible
│  └──────────────────────────────────────────────┘  │
│                                                    │
├────────────────────────────────────────────────────┤
│    [🎤]     [📷]    ┌─────────┐   [❤️]    [🚪]    │
│                     │ORB pill │                    │ ← ORB collapsed to pill
│                     │text only│                    │    mic blocked
│                     └─────────┘                    │
└────────────────────────────────────────────────────┘
```
- **Component**: `<OrbPill />` (text-only collapsed state)
- **Collapsed**: Text-only pill display (exception to visual parity)
- **Mic blocked**: Room owns audio, ORB cannot listen
- **Text input**: Type to interact with ORB
- **Switch confirmation**: Dialog required before enabling ORB mic

### Mic Switch Confirmation Dialog
```
┌────────────────────────────────────────────────────┐
│                                                    │
│         ╭─────────────────────────────╮            │
│         │                             │            │
│         │   Switch mic to ORB?        │            │
│         │                             │            │
│         │   Room audio will be muted  │            │
│         │   while ORB is listening.   │            │
│         │                             │            │
│         │  ┌─────────┐  ┌─────────┐  │            │
│         │  │ Cancel  │  │ Switch  │  │            │
│         │  └─────────┘  └─────────┘  │            │
│         │                             │            │
│         ╰─────────────────────────────╯            │
│                                                    │
└────────────────────────────────────────────────────┘
```
- **Trigger**: Tap ORB pill while in Live Room
- **Warning**: Clear explanation of audio switch
- **Actions**: Cancel (stay in room mode) or Switch (enable ORB mic)

---

## 21. Floating Input Bar

### Visual Specifications
```
┌──────────────────────────────────────────────────────┐
│                                                      │
│                  [Content Area]                      │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  │ ░                                           ░ │  │
│  │ ░  Type here...               [😊]   [📤]  ░ │  │ ← Frosted glass
│  │ ░                                           ░ │  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │
│  └────────────────────────────────────────────────┘  │
│                         ↕                            │
│                      16px gap                        │
│                         ↕                            │
├──────────────────────────────────────────────────────┤
│    [📅]     [👥]     (ORB)     [💰]     [👤]        │
└──────────────────────────────────────────────────────┘
```

### CSS Specifications
```css
.floating-input-bar {
  position: fixed;
  bottom: 76px;           /* 60px nav + 16px gap */
  left: 16px;
  right: 16px;
  z-index: 40;
  
  /* Frosted glass effect */
  background: rgba(31, 41, 55, 0.6);  /* gray-800/60 */
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  
  /* Shape */
  border-radius: 24px;    /* Pill-shaped */
  padding: 12px 16px;
  
  /* Border */
  border: 1px solid rgba(255, 255, 255, 0.1);
}
```

### Visibility Matrix

| Surface | Input Bar | Notes |
|---------|-----------|-------|
| Community | Optional | For posting (context-dependent) |
| Events | ❌ | Browse only |
| Meetups | ❌ | Browse only |
| Live Rooms | ✅ | Chat input |
| Shorts | ✅ | Comments |
| Discover | ❌ | Has search instead |
| Wallet | ❌ | Transaction-focused |
| Health | ❌ | Data display |
| Business Hub | ❌ | Action-focused |
| Inbox / Messages | ✅ | Messaging |
| Calendar | ❌ | Schedule view |
| Notifications | ❌ | Activity feed |
| Search | ❌ | Has search input |
| Profile | ❌ | Display/edit only |
| Ticket Success | ❌ | Confirmation only |

### ORB Relationship
- Input bar routes to **same AI pipeline** as ORB voice
- Text input = voice alternative
- Both trigger Autopilot suggestions when appropriate
- Input bar never conflicts with ORB (different z-layers)

---

## 22. Overlays

### Auth Overlay
```
┌────────────────────────────────────────────────────┐
│                                              ✕     │
├────────────────────────────────────────────────────┤
│                                                    │
│                                                    │
│                 Welcome to                         │
│                  VITANA                            │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🍎  Continue with Apple                      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ G   Continue with Google                     │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━  or  ━━━━━━━━━━━━━━━━           │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📧  email@example.com                        │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │           Continue with Email                │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│                                                    │
│  By continuing, you agree to our Terms of         │
│  Service and Privacy Policy.                      │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Event Detail Sheet
```
┌────────────────────────────────────────────────────┐
│                                              ✕     │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │                                              │  │
│  │              [EVENT IMAGE]                   │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  Yoga Retreat Berlin                               │
│                                                    │
│  📅 January 15, 2025 at 10:00 AM                   │
│  📍 Berlin Studio, Prenzlauer Berg                 │
│  💰 €49 per person                                 │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  About                                             │
│  Join us for a transformative yoga experience     │
│  in the heart of Berlin. This full-day retreat    │
│  includes morning meditation, vinyasa flow, and   │
│  a healthy lunch.                                 │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Host                                              │
│  ┌──────────────────────────────────────────────┐  │
│  │ [AV]  Sarah Miller  •  Yoga Instructor       │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │              Get Tickets                     │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Checkout Flow
```
┌────────────────────────────────────────────────────┐
│ ←               Checkout                           │
├────────────────────────────────────────────────────┤
│                                                    │
│  Order Summary                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🎫 Yoga Retreat Berlin                       │  │
│  │    1x General Admission            €49.00   │  │
│  ├──────────────────────────────────────────────┤  │
│  │ Subtotal                           €49.00   │  │
│  │ Fees                                €2.50   │  │
│  ├──────────────────────────────────────────────┤  │
│  │ Total                              €51.50   │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Your Details                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │ Name                                         │  │
│  │ John Smith                                   │  │
│  ├──────────────────────────────────────────────┤  │
│  │ Email                                        │  │
│  │ john@example.com                             │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                    │
│  Payment                                           │
│  ┌──────────────────────────────────────────────┐  │
│  │ 💳  **** **** **** 4242                      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │           Pay €51.50                         │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Share Sheet
```
┌────────────────────────────────────────────────────┐
│                                                    │
│  ╭────────────────────────────────────────────╮    │
│  │                                            │    │
│  │  Share Event                               │    │
│  │                                            │    │
│  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐       │    │
│  │  │ 📋  │  │ 💬  │  │ 📱  │  │ ✉️  │       │    │
│  │  │Copy │  │WhAp │  │Viber│  │Email│       │    │
│  │  └─────┘  └─────┘  └─────┘  └─────┘       │    │
│  │                                            │    │
│  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐       │    │
│  │  │ 💬  │  │ 📘  │  │ 🐦  │  │ 📷  │       │    │
│  │  │ SMS │  │ FB  │  │  X  │  │ IG  │       │    │
│  │  └─────┘  └─────┘  └─────┘  └─────┘       │    │
│  │                                            │    │
│  │  ┌──────────────────────────────────────┐  │    │
│  │  │         More Options...              │  │    │
│  │  └──────────────────────────────────────┘  │    │
│  │                                            │    │
│  ╰────────────────────────────────────────────╯    │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Overlay Rules
- **Full-screen**: All overlays use `fixed inset-0`
- **No centered modals**: Desktop-style modals forbidden on mobile
- **Component**: Use `MobileFullScreenSheet` wrapper
- **Animation**: Slide up from bottom or fade in
- **Close**: ✕ button or swipe down gesture
- **Z-index**: z-70 (above all other elements)

---

## Summary: Input Bar Visibility

| # | Surface | Route | Input Bar |
|---|---------|-------|-----------|
| 1 | Community | `/m/community` | Optional |
| 2 | Events | `/m/events` | ❌ |
| 3 | Meetups | `/m/meetups` | ❌ |
| 4 | Live Rooms | `/m/live` | ✅ |
| 5 | Shorts | `/m/shorts` | ✅ |
| 6 | Discover | `/m/discover` | ❌ |
| 7 | Wallet | `/m/wallet` | ❌ |
| 8 | Health | `/m/health` | ❌ |
| 9 | Business Hub | `/m/business` | ❌ |
| 10 | Inbox / Messages | `/m/messages` | ✅ |
| 11 | Calendar | `/m/calendar` | ❌ |
| 12 | Notifications | `/m/notifications` | ❌ |
| 13 | Search | `/m/search` | ❌ |
| 14 | Profile | `/m/profile` | ❌ |
| 15 | Ticket Success | `/m/ticket/:id` | ❌ |

---

## Changelog

| Date | Change |
|------|--------|
| 2024-12-26 | Final comprehensive wireframes aligned with approval document |
| 2024-12-26 | Added floating input bar with visibility matrix |
| 2024-12-26 | Added layer order hierarchy documentation |
| 2024-12-26 | Renamed "Services Hub" to "Discover" throughout |
| 2024-12-26 | Added ORB states including Live mode mic switch confirmation |
| 2024-12-26 | Complete 22-section documentation |
