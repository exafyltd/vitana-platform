# Summary: Mobile PWA Rules

> A summary of the mandatory rules governing all VITANA Mobile PWA development, covering overlays, navigation, sharing, ORB modes, i18n, performance, routing, and component architecture.

## Content

The Mobile PWA Rules document defines 13 mandatory sections:

### Rule 1: Full-Screen Overlay Rule
All popups, dialogs, and sheets must be full-screen on mobile using `MobileFullScreenSheet` wrapper with `fixed inset-0`. Desktop-style centered modals are prohibited.

### Rule 2: Hybrid Browsing Model
Events/Meetups/Live Rooms use horizontal navigation (swipe left/right with visible arrow controls). Shorts use vertical navigation (swipe up/down). Only preload next 1 item. Use `embla-carousel-react` for horizontal carousels.

### Rule 3: Share System Rules
All share URLs preserve language (`?lang=de|en`). Public pages use `/pub/*` routes (no auth required). After inline auth, return user to exact CTA action context preserving `redirectTo`, `?lang=`, and UTM parameters. Instagram Story fallback provides pre-formatted caption.

### Rule 4: ORB Mode Rules
Single ORB with three modes: browse (default), action (autopilot), live (text-only). ORB never steals mic in Live Rooms. State transitions enforced via state machine. `live -> action` transition is blocked.

### Rule 5: Live Room Mic-Switch Flow
Explicit user confirmation required to switch mic to ORB. `useAudioPriority` hook manages audio priority. "Return mic to room" button provided.

### Rule 6: i18n Rules (German-First)
Auto-detection based on `navigator.language`. User override persisted via localStorage and URL parameter. Translation files required for all 14 surfaces in both `de.json` and `en.json`.

### Rule 7: Performance Non-Negotiables
Phase gates requiring: route-level code splitting, skeleton loaders, next-1-item preload, no WebRTC caching, speak-to-filter latency under 600ms, mid-tier Android validation.

### Rule 8: Mobile Routing
Dedicated `/m/*` routes with `MobileLayout` wrapper. Mobile must not reuse desktop routes. MobileLayout includes bottom nav, ORB integration, safe area handling.

### Rule 9: Component Architecture
Shared components in `src/components/mobile/` with surfaces, overlays, and cards subdirectories.

### Rule 10: Community Surface Special Case
Community is a social aggregation lens with sticky filter pills (Events, Meetups, Live, People) that filter content without changing routes.

### Rule 11: Bottom Navigation Customization
ORB permanently fixed in center. 4 user-customizable tab positions. 10 eligible destinations. Suggestions are never automatic.

### Rule 12: Context-Aware Floating Input Bar
Pill-shaped frosted glass input bar, 16px above bottom nav. Context-aware visibility per surface. Routes to same ORB processing pipeline as voice.

### Rule 13: ORB Visual Parity
Mobile ORB must use identical `VitanalandPortalSeed` component from desktop. All 8 visual layers mandatory. No simplified mobile variant, no static fallback.

## Related Pages

- [[mobile-pwa-architecture]]
- [[maxina-orb]]
- [[mobile-surfaces]]

## Sources

- `raw/mobile-pwa/mobile-pwa-rules.md`

## Last Updated

2026-04-12
