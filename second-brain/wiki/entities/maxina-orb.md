# MAXINA Orb

> The MAXINA Orb (also called VITANA Orb or VitanalandPortalSeed) is the central AI assistant interface -- a visually rich animated sphere that provides voice and text interaction, proactive longevity guidance, and context-aware behavior across all platform surfaces.

## Overview

The ORB is a single global instance present on every screen, serving as the primary intelligence layer for the VITANA platform. It transitions between three modes and maintains visual parity between desktop and mobile.

## ORB Modes

| Mode | Trigger | Mic | UI | Use Case |
|------|---------|-----|-----|----------|
| `browse` | Default on feeds/players | Allowed | Floating ORB button + panel | General browsing, voice commands |
| `action` | Autopilot suggestion | Allowed | Panel with suggestion cards | AI-driven action recommendations |
| `live` | Enter Live Room | Blocked | Collapsed pill (text-only) | Live room participation without mic conflict |

### State Machine

```
browse <-> action  (free transition)
browse -> live     (entering live room)
action -> live     (entering live room from action)
live -> browse     (exiting live room)
live -> action     NOT ALLOWED (must exit live first)
```

## Voice Interface

The ORB provides voice input with speak-to-filter capability (latency target: <600ms). In Live Rooms, voice is disabled to prevent mic conflicts. Users can explicitly switch mic to ORB via a confirmation dialog: "Switch mic to ORB? Room audio will be muted."

**Mic-Switch Flow (Live Room):**
1. User taps ORB pill, selects "Use ORB voice"
2. Confirmation dialog presented
3. Room mic paused via `useAudioPriority`
4. ORB mic activated with "Return mic to room" button
5. On return: stop ORB mic, resume room mic, ORB returns to text-only

## Floating Input Bar Integration

The floating input bar provides text-based interaction as an alternative to voice. It routes to the same ORB processing pipeline, enabling "type to filter" with the same logic as "speak to filter." In Live Rooms, both the input bar (for room chat) and the ORB pill (for AI queries, text-only) remain visible but serve different purposes.

## Visual Specification

The ORB must use the exact same `VitanalandPortalSeed` component on both desktop and mobile. No simplified mobile variant is permitted.

### 8 Visual Layers (All Required)
1. **Outer Halo** -- Ethereal purple gradient ring
2. **Second Halo** -- Inner glow layer
3. **Thin Ring** -- Crisp edge definition
4. **Glass Shell** -- Radial gradient sphere
5. **Nebula Clouds** -- 3-layer rotating nebula (35s, 45s, 60s cycles)
6. **Aurora Strands** -- 4 animated aurora bands
7. **Triple Core** -- Central light core
8. **Micro-fragments** -- 10+ floating particles

### Size Configuration

| Context | Size | Dimensions |
|---------|------|------------|
| Bottom Navigation | `sm` | 48x48px |
| Expanded Listening | `md` | 80x80px |
| Full-screen overlay | `lg` | 240x240px |

### Audio State Animations

| State | Visual Behavior |
|-------|----------------|
| `idle` | Subtle breathing (scale 0.98-1.02), slow nebula rotation |
| `listening` | Enhanced glow, faster rotation, halo pulse |
| `processing` | Rainbow gradient shift, wave patterns |
| `error` | Red tint flash, shake micro-animation |

### Behavior Parity (Desktop = Mobile)

- Click sound: `spark-chime.mp3` at 0.12 volume
- Hover/touch glow: Scale + glow increase
- Expansion: Overlay fade + orb grow
- Keyboard shortcut: `Ctrl+Shift+V` (desktop only)

## Longevity Guide Role

Under the longevity reorientation plan, the ORB is elevated from "feature button" to "longevity guide":
- Proactive suggestions (not just reactive responses)
- Greeting microcopy on idle state
- Personalized longevity insights and encouragement
- Connects user activity to longevity outcomes

## Position in Navigation

- **Bottom Nav**: Always fixed in center position (non-customizable)
- **Mobile z-index**: z-60 when expanded (above bottom nav at z-50, below overlays at z-70)
- **Sidebar**: OVRL-003 (VITANA Orb Button) in sidebar navigation

## Cross-Role Availability

The ORB (OVRL-001, OVRL-002, OVRL-003) is available to all authenticated users across all roles (Community, Patient, Professional, Staff, Admin). It provides voice navigation to any screen in the application.

## Performance Constraints

If mobile performance is insufficient for full ORB rendering:
- Optimize the shared component, do not fork it
- Use `will-change: transform` for GPU acceleration
- Consider reduced micro-fragments count (not removal)
- No static fallback, no mobile-specific visual changes, no removal of animation layers

## Related Pages

- [[mobile-pwa-architecture]] -- ORB integration in mobile PWA
- [[mobile-surfaces]] -- Surfaces where ORB appears
- [[design-system]] -- Visual requirements and patterns
- [[screen-registry]] -- ORB overlay screens (OVRL-001 to OVRL-003)

## Sources

- `raw/mobile-pwa/mobile-pwa-rules.md`
- `raw/mobile-pwa/mobile-wireframes.md`
- `raw/mobile-pwa/mobile-longevity-reorientation-plan.md`
- `raw/screen-registry/NAVIGATION_MAP.md`

## Last Updated

2026-04-12
