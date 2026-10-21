# Mobile PWA Longevity Reorientation Plan

> **Status**: Planning  
> **Created**: 2025-12-26  
> **Last Updated**: 2025-12-26

---

## 1. Executive Summary

### The Problem

The current mobile experience feels like a **social platform with health features**. From the user's first glance:

- Longevity feels like one feature among many
- VITANALAND doesn't feel like a destination
- Health & lifespan extension are not the primary gravity center
- We optimized for usability and virality but diluted the LONGEVITY thesis

### The Solution

Reorient the entire mobile experience so that from **second 1**, VITANA feels like:

- 🧬 **A LONGEVITY WORLD** — not a social app with health features
- 🧭 **A place you enter** — not an app you scroll
- 📈 **A system helping you live longer** — not a feed you consume

This is not a structural rebuild. The architecture is correct. This is an **experience gravity shift**.

---

## 2. Core Thesis

### The Longevity World Mental Model

VITANA Mobile must communicate its core purpose immediately:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   "You are entering a world designed to extend your lifespan   │
│    and improve your healthspan. Everything here exists to      │
│    help you live longer and better."                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Three Pillars of Longevity Gravity

1. **Entry Ritual**: First-time users experience a portal animation that sets the tone
2. **Persistent Context**: Vitana Index visible on ALL surfaces, not just health screens
3. **ORB as Guide**: The ORB proactively guides longevity actions, not just responds to requests

### What This Changes

| Before | After |
|--------|-------|
| Social feed as home | Vitanaland (longevity dashboard) as home |
| ORB as feature button | ORB as longevity guide |
| Health as one section | Health metrics visible everywhere |
| Generic app opening | Longevity entry experience |
| Social activity primary | Longevity progress primary, social supports it |

---

## 3. Structural Foundation (What Stays)

The following architectural elements remain **unchanged**:

### Navigation Architecture

1. **Bottom Navigation Bar** (Primary)
   - 5 slots: 4 destinations + center ORB
   - Fixed at bottom, always visible
   - ORB in center position

2. **Center ORB** (Primary Intelligence Layer)
   - Single global instance
   - Three modes: Browse, Action, Live
   - Voice/text input capability

3. **Full-Screen Sidebar Menu** (Complete Access)
   - Kebab icon opens from left
   - All 14 experiences accessible
   - Full-screen overlay (fixed inset-0)

4. **Floating Text Input Bar**
   - Semi-transparent, above bottom nav
   - Available on selected surfaces
   - Quick text input to ORB

### Mobile-First Rules (Preserved)

- All dialogs, popups, sheets = **full-screen** (fixed inset-0)
- No tabs, breadcrumbs, or nested navigation
- One item per viewport with vertical scroll
- Horizontal scroll for Events/Meetups/Live Rooms

### Terminology (Preserved)

All original naming conventions remain:
- Community (not Citizens)
- Events (not Gatherings)
- Meetups (not Circles)
- Profile (not Identity)
- Shorts (not Moments)
- Live Rooms (not Live Circles)

---

## 4. Experience Gravity Changes (What's New)

### 4.1 Home Surface: "Vitanaland"

The default home surface is renamed from generic "Home" to **"Vitanaland"**.

This is not just a name change—it's the **longevity dashboard**:
- Vitana Index prominent (not hidden in Health)
- Today's Longevity Priority front and center
- ORB greeting with personalized message
- Quick-access to other surfaces (secondary)

### 4.2 Longevity Entry Experience

First-time users (and optionally returning users) experience a **portal animation** that establishes the "entering a world" feeling.

### 4.3 ORB Elevated to Guide

The ORB transitions from "feature button" to **"longevity guide"**:
- Proactive suggestions (not just reactive)
- Greeting microcopy on idle
- Matches desktop VitanalandPortalSeed visual language

### 4.4 Vitana Index on All Surfaces

A compact Vitana Index bar appears on **every surface**, maintaining longevity gravity regardless of where the user navigates.

### 4.5 Navigation Reorder

Health-related surfaces move up in priority:
- Bottom Nav: Vitanaland first (not Community)
- Sidebar: Health surfaces at top

---

## 5. Longevity Entry Experience

### Purpose

Establish the "entering a world" feeling from the first moment. Users should feel they're crossing a threshold into a longevity-focused environment.

### When It Triggers

- **First-time users**: Full portal animation (mandatory)
- **Returning users**: Abbreviated version or skip (configurable)
- **Session storage**: Prevents replay within same session

### Animation Sequence

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                         Phase 1: Void                          │
│                     (Dark background fade-in)                  │
│                                                                │
│                              ✧                                 │
│                           ╭─────╮                              │
│                          (  ORB  )  ← Orb appears, breathing   │
│                           ╰─────╯                              │
│                                                                │
│                         Phase 2: Portal                        │
│                    (Orb expands, glow radiates)                │
│                                                                │
│              "Welcome to your longevity journey"               │
│                                                                │
│                         Phase 3: Entry                         │
│                   (Screen transitions to Vitanaland)           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Animation Specifications

| Phase | Duration | Easing | Description |
|-------|----------|--------|-------------|
| Void | 400ms | ease-out | Dark background fades in |
| Orb Appear | 600ms | cubic-bezier(0.34, 1.56, 0.64, 1) | ORB scales in with bounce |
| Orb Breathe | 2000ms | ease-in-out | ORB pulses 2-3 times |
| Text Reveal | 500ms | ease-out | Welcome message fades in |
| Hold | 1500ms | - | User absorbs the moment |
| Transition | 800ms | ease-in-out | Fade/morph into Vitanaland home |

### Welcome Message Variants

Rotate based on time of day and user context:

- "Welcome to your longevity journey"
- "Your path to a longer life starts here"
- "Good morning. Let's extend your lifespan today."
- "Welcome back to VITANALAND"

### Skip Behavior

- Tap anywhere to skip (with subtle indicator)
- Skip button appears after 1.5s if no interaction
- Skipping still sets session flag

---

## 6. Vitanaland Home Surface

### Purpose

The home surface is the **longevity command center**, not a social feed. Users should immediately see their health status and today's priority.

### Layout Structure

```
┌────────────────────────────────────────────────────────────────┐
│ ≡                    VITANALAND                          🔔    │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │              ┌─────────────────────┐                     │  │
│  │              │   VITANA INDEX      │                     │  │
│  │              │        74           │                     │  │
│  │              │      ↑ +3 pts       │                     │  │
│  │              │   "Strong Progress" │                     │  │
│  │              └─────────────────────┘                     │  │
│  │                                                          │  │
│  │              +2.3 years projected                        │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  📋 TODAY'S LONGEVITY PRIORITY                           │  │
│  │                                                          │  │
│  │  "Complete your sleep log to unlock insights"            │  │
│  │                                                          │  │
│  │  [ Start Now ]                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  💬 ORB MESSAGE                                          │  │
│  │                                                          │  │
│  │  "Your VO2max improved 8% this month. Keep moving!"      │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ 🏃 Health   │ │ 👥 Community│ │ 📅 Events   │               │
│  │   Trackers  │ │             │ │             │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  📊 RECENT ACTIVITY                                      │  │
│  │                                                          │  │
│  │  • Logged 7.2h sleep (above goal!)                       │  │
│  │  • Joined "Longevity Runners" group                      │  │
│  │  • RSVP'd to Cold Plunge Saturday                        │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  💬 Ask VITANA anything...                               │  │ ← Floating Input
│  └──────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│  [Vitanaland]  [Community]  [ ◉ ORB]  [Wallet]  [Profile]     │ ← Bottom Nav
└────────────────────────────────────────────────────────────────┘
```

### Section Priority Order

1. **Vitana Index Card** (Hero, top-center)
   - Current score prominently displayed
   - Trend indicator (↑/↓/→)
   - Projected lifespan impact
   - Tappable to expand full Health dashboard

2. **Today's Longevity Priority** (Action-oriented)
   - AI-generated daily suggestion
   - Single clear CTA
   - Based on user's current health gaps

3. **ORB Message** (Proactive guidance)
   - Personalized insight or encouragement
   - Rotates periodically
   - Connects activity to longevity outcomes

4. **Quick-Access Cards** (Navigation)
   - 3-4 cards for key surfaces
   - Health Trackers, Community, Events
   - Visual shortcuts, not primary content

5. **Recent Activity** (Supporting context)
   - Last 3-5 relevant actions
   - Mix of health and social
   - Each tied to longevity impact

### What This Is NOT

- ❌ A social feed (Community has that)
- ❌ A notification center (different surface)
- ❌ A settings dashboard (Profile has that)
- ❌ Empty without data (always shows something actionable)

---

## 7. ORB as Guide (Desktop Parity)

### Purpose

The ORB is not a feature button—it's the **primary intelligence layer** that guides users toward longevity actions. This matches the desktop VITANALAND experience.

### Visual Architecture

The mobile ORB uses the same `OrbCore` / `VitanalandPortalSeed` component system as desktop:

```typescript
// Same component, different size
<OrbCore 
  size="sm"           // 48px for bottom nav
  audioState={state}  // idle | listening | processing | error
  volumeLevel={level}
  enableFloat={false} // No float in bottom nav
  layoutId="vitana-orb"
/>
```

### Visual Elements (Preserved from Desktop)

- Darker blue/purple tones
- Nebula layers with aurora strands
- Micro-fragment particles
- Glowing core with elliptical halo
- Breathing animation in idle state
- Pulsating halos during listening
- Processing animation during thinking

### Size Specifications

| Context | Size | Dimensions |
|---------|------|------------|
| Bottom Nav (default) | sm | 48px |
| Expanded (listening) | md | 96px |
| Entry Animation | xl | 160px |
| Full-screen overlay | xl | 160px |

### ORB States

| State | Visual | Audio | Behavior |
|-------|--------|-------|----------|
| Idle | Slow breathing, soft glow | Silent | Shows greeting microcopy |
| Listening | Pulsating halos, brighter core | Shimmer chime | Captures voice input |
| Processing | Rotating fragments, thinking hum | Low hum loop | AI processing |
| Error | Red tint, shake | Error tone | Shows error message |

### Proactive Behavior (NEW for Mobile)

Unlike a passive button, the ORB **proactively engages**:

1. **Greeting Microcopy** (on Vitanaland home)
   - Rotates every 30 seconds
   - Personalized based on context
   - Examples:
     - "Ready when you are"
     - "Tap to extend your lifespan"
     - "What's your longevity goal today?"

2. **Nudge Animations** (after 30s idle on Vitanaland)
   - Subtle pulse to draw attention
   - Not intrusive, just present

3. **Contextual Suggestions** (after actions)
   - After logging sleep: "Great! Want to see how this affects your index?"
   - After viewing event: "This event could boost your social connection score"

### Mode System (Preserved)

| Mode | Trigger | Behavior |
|------|---------|----------|
| Browse | Default | Voice/text filtering of current feed |
| Action | Autopilot active | Shows suggestions with confirm/reject |
| Live | Inside Live Room | Collapsed to pill, text-only, mic blocked |

---

## 8. Vitana Index Visibility Rules

### Core Principle

The Vitana Index must be visible on **every surface**, not just Health screens. This maintains longevity gravity regardless of where users navigate.

### Compact Bar Specification

```
┌────────────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────┐ │
│ │  🧬 Vitana: 74 ↑  |  +2.3 years                            │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│                    [Rest of surface content]                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Bar Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│  🧬  │  Vitana: 74  │  ↑  │  |  │  +2.3 years  │  [ Expand ]   │
│  ▲      ▲             ▲     ▲       ▲              ▲           │
│  │      │             │     │       │              │           │
│  Icon   Score       Trend  Divider Impact        Action        │
└─────────────────────────────────────────────────────────────────┘
```

### Visibility Matrix

| Surface | Vitana Bar Position | Tap Action |
|---------|---------------------|------------|
| Vitanaland (Home) | Hero card (expanded) | Shows details modal |
| Community | Sticky top bar | Navigates to Health |
| Events | Sticky top bar | Shows relevance tooltip |
| Meetups | Sticky top bar | Shows relevance tooltip |
| Live Rooms | Floating pill (non-intrusive) | Navigates to Health |
| Shorts | Overlay (top-right corner) | Navigates to Health |
| Podcasts | Sticky top bar | Navigates to Health |
| Music | Minimized (icon only in player) | Navigates to Health |
| Discover | Sticky top bar | Shows product longevity tags |
| Wallet | Above balance card | Shows health investments |
| Profile | Below header | Shows personal trends |
| Health | Full dashboard | N/A (already here) |
| Business Hub | Sticky top bar | Shows client health metrics |
| Inbox | Header right | Quick glance only |

### Styling

```css
.vitana-compact-bar {
  background: hsl(var(--background) / 0.8);
  backdrop-filter: blur(12px);
  border: 1px solid hsl(var(--border) / 0.5);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
}

.vitana-score {
  color: hsl(var(--primary));
  font-weight: 600;
}

.vitana-trend-up { color: hsl(var(--success)); }
.vitana-trend-down { color: hsl(var(--destructive)); }
.vitana-trend-stable { color: hsl(var(--muted-foreground)); }

.vitana-impact {
  color: hsl(var(--muted-foreground));
}
```

### Hide Conditions

The Vitana Bar should hide in these contexts:
- Full-screen media playback (video, audio focus mode)
- Camera/photo capture mode
- Payment/checkout flows (focus on transaction)
- Onboarding flows (avoid overwhelming new users)
- Text input focused (keyboard up)

---

## 9. Navigation Reorder

### Bottom Navigation Bar

**Current Default:**
```
[ Community ] [ Events ] [ ◉ ORB ] [ Wallet ] [ Profile ]
```

**New Default:**
```
[ Vitanaland ] [ Community ] [ ◉ ORB ] [ Wallet ] [ Profile ]
```

### Rationale

1. **Vitanaland first**: Longevity dashboard is the home, not social feed
2. **Community second**: Social activity supports longevity, remains accessible
3. **ORB center**: Unchanged, still the primary intelligence layer
4. **Wallet/Profile**: Unchanged, utility access

### Alternative Configuration (User Customizable)

If users prefer health-focused nav:
```
[ Vitanaland ] [ Health ] [ ◉ ORB ] [ Community ] [ Profile ]
```

### Sidebar Menu Reorder

**Current Order:**
```
1. Community
2. Events
3. Meetups
4. Live Rooms
5. Shorts
6. Health
7. ...
```

**New Order:**
```
1. Vitanaland (Home)
2. Health
3. Community
4. Events
5. Meetups
6. Live Rooms
7. Shorts
8. Podcasts
9. Music
10. Discover
11. Wallet
12. Business Hub
13. Inbox
14. Profile
```

### Visual Hierarchy in Sidebar

```
┌────────────────────────────────────────────────────────────────┐
│  ✕                                                             │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  🏠  Vitanaland                              ← PRIMARY    │  │
│  │  🧬  Health                                  ← PRIMARY    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ── COMMUNITY ──────────────────────────────────────────────   │
│  👥  Community                                                 │
│  📅  Events                                                    │
│  🤝  Meetups                                                   │
│  🎥  Live Rooms                                                │
│                                                                │
│  ── CONTENT ────────────────────────────────────────────────   │
│  📱  Shorts                                                    │
│  🎙️  Podcasts                                                  │
│  🎵  Music                                                     │
│                                                                │
│  ── UTILITY ────────────────────────────────────────────────   │
│  🔍  Discover                                                  │
│  💳  Wallet                                                    │
│  💼  Business Hub                                              │
│  📬  Inbox                                                     │
│  👤  Profile                                                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 10. Surface-by-Surface Longevity Integration

### How Each Surface Connects to Longevity

| # | Surface | Longevity Connection | Vitana Context |
|---|---------|---------------------|----------------|
| 1 | **Vitanaland** | Longevity command center | Full Vitana Index card, daily priority |
| 2 | **Health** | Core longevity tracking | Full dashboard, all biomarkers |
| 3 | **Community** | Social connection → longevity | "Social connections extend lifespan by 5 years" |
| 4 | **Events** | Activity participation | Tag events with health benefits |
| 5 | **Meetups** | Group accountability | "Group exercise 30% more effective" |
| 6 | **Live Rooms** | Real-time community | Show active longevity discussions |
| 7 | **Shorts** | Micro-learning | Tag with longevity topics |
| 8 | **Podcasts** | Health education | Curate longevity content |
| 9 | **Music** | Stress reduction | "Music reduces cortisol by 25%" |
| 10 | **Discover** | Longevity products | Supplements, devices, services |
| 11 | **Wallet** | Health investments | Track longevity spending ROI |
| 12 | **Business Hub** | Health creator economy | Offer longevity services |
| 13 | **Inbox** | Health reminders | AI-generated check-ins |
| 14 | **Profile** | Personal longevity journey | Timeline, achievements, goals |

### Content Longevity Tags

All content (posts, events, products) can optionally display longevity relevance:

```
┌──────────────────────────────────────────────────────────────┐
│  [Avatar] Sarah K.                               2h ago      │
│                                                              │
│  Just completed my 30-day cold plunge challenge! 🧊         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 🧬 Longevity Impact: Cold Exposure Protocol            │  │
│  │    +0.3 years • Immune boost • Inflammation reduction  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ❤️ 42    💬 12    ↗️ Share                                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 11. New Mobile PWA Rules (14-17)

### Rule 14: Longevity Gravity Principle

> The Vitana Index or longevity context must be visible on **every surface**.

**Implementation:**
- Compact Vitana Bar on all surfaces (see Section 8)
- Longevity tags on relevant content
- Health impact shown for actions

**Exceptions:**
- Full-screen media playback
- Payment/checkout flows
- Camera capture modes
- Text input focus (keyboard up)

### Rule 15: Entry Ritual Requirement

> First-time users must experience the Longevity Entry Experience before accessing the app.

**Implementation:**
- Portal animation on first launch
- Session storage prevents replay
- Skip option after 1.5s
- Configurable for returning users

**Trigger:**
```typescript
const shouldShowEntry = !sessionStorage.getItem('vitana-entry-complete');
```

### Rule 16: ORB as Guide

> The ORB proactively suggests longevity actions, not just responds to requests.

**Implementation:**
- Greeting microcopy rotation on Vitanaland
- Nudge animations after idle
- Contextual suggestions after user actions
- Same visual architecture as desktop (OrbCore component)

**Behavior:**
```typescript
// ORB greeting rotation
const greetings = [
  "Ready when you are",
  "Tap to extend your lifespan",
  "What's your longevity goal today?",
  "I noticed your sleep improved—want insights?",
];
```

### Rule 17: Vitana Index Visibility

> The Vitana Index must be displayed in compact form on all 14 surfaces.

**Implementation:**
- Consistent compact bar component
- Position varies by surface (sticky top, floating, corner)
- Tappable to navigate to Health or show details
- Respects hide conditions (Section 8)

**Component:**
```typescript
<VitanaCompactBar 
  position="sticky-top" // or "floating" | "corner" | "inline"
  variant="full" // or "minimal" | "icon-only"
  onTap={() => navigate('/health')}
/>
```

---

## 12. Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Deliverables:**
- [ ] Vitanaland home surface component
- [ ] Vitana Index compact bar component
- [ ] Bottom nav reorder (Vitanaland first)
- [ ] Sidebar menu reorder

**Files to Create/Modify:**
- `src/pages/mobile/Vitanaland.tsx` (new)
- `src/components/mobile/VitanaCompactBar.tsx` (new)
- `src/components/mobile/MobileBottomNav.tsx` (modify)
- `src/components/mobile/MobileSidebar.tsx` (modify)

### Phase 2: Entry Experience (Week 2-3)

**Deliverables:**
- [ ] Longevity Entry Experience animation
- [ ] Portal ORB component
- [ ] Welcome message system
- [ ] Session storage management

**Files to Create:**
- `src/components/mobile/LongevityEntryExperience.tsx` (new)
- `src/components/mobile/PortalOrb.tsx` (new)
- `src/lib/entryExperience.ts` (new)

### Phase 3: ORB as Guide (Week 3-4)

**Deliverables:**
- [ ] Greeting microcopy rotation
- [ ] Nudge animation system
- [ ] Contextual suggestion triggers
- [ ] OrbCore integration in mobile nav

**Files to Modify:**
- `src/components/vitanaland/OrbCore.tsx` (add mobile support)
- `src/components/mobile/MobileBottomNav.tsx` (integrate OrbCore)
- `src/hooks/useOrbGreetings.ts` (new)
- `src/hooks/useOrbNudge.ts` (new)

### Phase 4: Vitana Index Everywhere (Week 4-5)

**Deliverables:**
- [ ] Compact bar on all 14 surfaces
- [ ] Surface-specific positioning
- [ ] Hide condition logic
- [ ] Tap navigation

**Files to Modify:**
- All 14 mobile surface components
- `src/components/mobile/VitanaCompactBar.tsx` (variants)

### Phase 5: Longevity Context (Week 5-6)

**Deliverables:**
- [ ] Longevity tags for content
- [ ] Health impact indicators
- [ ] Surface-specific longevity messaging

**Files to Create:**
- `src/components/mobile/LongevityTag.tsx` (new)
- `src/components/mobile/HealthImpactBadge.tsx` (new)

---

## 13. Success Criteria

### Immediate (First Session)

| Criterion | Measurement |
|-----------|-------------|
| User understands "this is about longevity" | Entry experience completion rate > 85% |
| Vitana Index seen on first surface | 100% (by design) |
| ORB feels like a guide | Greeting shown within 5 seconds |

### Short-term (First Week)

| Criterion | Measurement |
|-----------|-------------|
| Health surfaces accessed more often | Health visits ↑ 30% vs current |
| Vitana Index taps from other surfaces | > 2 taps/user/day average |
| Entry experience not skipped | Skip rate < 30% |

### Long-term (First Month)

| Criterion | Measurement |
|-----------|-------------|
| Users describe VITANA as "longevity app" | Qualitative feedback alignment |
| Health engagement sustained | Health feature retention > 60% |
| Social activity supports health | Correlation between social + health engagement |

### Qualitative Success Indicators

1. **First-time users immediately understand** that this is a longevity-focused platform
2. **Health and lifespan feel primary**, social activity feels supporting
3. **VITANALAND feels like a destination** to enter, not an app to scroll
4. **The ORB feels like a guide**, not just a feature button
5. **Every surface connects back** to the longevity thesis

---

## 14. Appendix: Wireframes

### A. Longevity Entry Experience

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                                                                │
│                                                                │
│                                                                │
│                              ✧                                 │
│                                                                │
│                           ╭─────╮                              │
│                          ╱       ╲                             │
│                         │   ◉     │  ← ORB with nebula/aurora  │
│                          ╲       ╱                             │
│                           ╰─────╯                              │
│                                                                │
│                              ✧                                 │
│                                                                │
│                                                                │
│            "Welcome to your longevity journey"                 │
│                                                                │
│                                                                │
│                                                                │
│                         [ Enter ]                              │
│                                                                │
│                                                                │
│                                            Skip →              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### B. Vitanaland Home Surface

```
┌────────────────────────────────────────────────────────────────┐
│ ≡                    VITANALAND                          🔔    │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    VITANA INDEX                          │  │
│  │                                                          │  │
│  │                        74                                │  │
│  │                       ↑ +3                               │  │
│  │                                                          │  │
│  │               "Strong Progress"                          │  │
│  │                                                          │  │
│  │            +2.3 years projected lifespan                 │  │
│  │                                                          │  │
│  │                    [ View Details ]                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  📋 TODAY'S PRIORITY                                     │  │
│  │                                                          │  │
│  │  Complete your morning hydration log                     │  │
│  │                                                          │  │
│  │  [ Log Now ]                              Est: 30 sec    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  💬 "Your VO2max is trending up. Keep it going!"         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                   │
│  │ Health │ │ Comm.  │ │ Events │ │ Wallet │                   │
│  └────────┘ └────────┘ └────────┘ └────────┘                   │
│                                                                │
│  RECENT ACTIVITY                                               │
│  • Logged 7.2h sleep                            2h ago         │
│  • Joined morning yoga session                  Yesterday      │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  💬 Ask VITANA anything...                                     │
├────────────────────────────────────────────────────────────────┤
│  [Vitanaland]  [Community]  [ ◉ ]  [Wallet]  [Profile]        │
└────────────────────────────────────────────────────────────────┘
```

### C. Vitana Compact Bar (On Other Surfaces)

```
┌────────────────────────────────────────────────────────────────┐
│ ≡                    COMMUNITY                           🔔    │
├────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐   │
│ │  🧬 Vitana: 74 ↑  |  +2.3 years                      ▸   │   │ ← Compact Bar
│ └──────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  [Avatar] Dr. Sarah M.                        2h ago     │  │
│  │                                                          │  │
│  │  Just finished my quarterly blood panel...               │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │ 🧬 Longevity: Biomarker Tracking                   │  │  │ ← Content Tag
│  │  └────────────────────────────────────────────────────┘  │  │
│  │                                                          │  │
│  │  ❤️ 24   💬 8   ↗️                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  [Avatar] Mike T.                             4h ago     │  │
│  │                                                          │  │
│  │  Morning cold plunge complete! 🧊                        │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  💬 Ask VITANA anything...                                     │
├────────────────────────────────────────────────────────────────┤
│  [Vitanaland]  [Community]  [ ◉ ]  [Wallet]  [Profile]        │
└────────────────────────────────────────────────────────────────┘
```

### D. ORB in Bottom Navigation

```
                    Normal State
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Vitanaland    Community     ◉ ORB     Wallet     Profile    │
│       🏠           👥         ╭───╮       💳         👤        │
│                              │ ◉ │                             │
│                               ╰───╯                            │
│                                                                │
│                         "Ready when                            │
│                          you are"                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘

                    Listening State
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   Vitanaland    Community     ◉ ORB     Wallet     Profile    │
│       🏠           👥        ╭─────╮      💳         👤        │
│                             │ ◉◉◉ │ ← Expanded, pulsating     │
│                              ╰─────╯                           │
│                                                                │
│                        "I'm listening..."                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### E. Sidebar with Longevity Hierarchy

```
┌────────────────────────────────────────────────────────────────┐
│  ✕                                                       ⚙️    │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  🧬 Vitana: 74 ↑  |  +2.3 years                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ═══════════════════════════════════════════════════════════   │
│                                                                │
│  🏠  Vitanaland                                    ← ACTIVE    │
│  🧬  Health                                                    │
│                                                                │
│  ── COMMUNITY ──────────────────────────────────────────────   │
│                                                                │
│  👥  Community                                                 │
│  📅  Events                                         3 new      │
│  🤝  Meetups                                                   │
│  🎥  Live Rooms                                     2 live     │
│                                                                │
│  ── CONTENT ────────────────────────────────────────────────   │
│                                                                │
│  📱  Shorts                                                    │
│  🎙️  Podcasts                                                  │
│  🎵  Music                                                     │
│                                                                │
│  ── UTILITY ────────────────────────────────────────────────   │
│                                                                │
│  🔍  Discover                                                  │
│  💳  Wallet                                                    │
│  💼  Business Hub                                              │
│  📬  Inbox                                          5          │
│  👤  Profile                                                   │
│                                                                │
│  ═══════════════════════════════════════════════════════════   │
│                                                                │
│  ⚙️  Settings                                                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-26 | Initial comprehensive plan |

---

## Related Documents

- `docs/mobile-wireframes.md` — Mobile wireframe specifications
- `docs/mobile-pwa-rules.md` — Mobile PWA development rules
- `docs/mobile-screen-inventory.md` — 14 mobile experiences inventory
- `src/components/vitanaland/OrbCore.tsx` — ORB component reference
