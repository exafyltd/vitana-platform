# Design System

> VITANA's design system defines mandatory UI patterns, component reuse standards, horizontal list components, emoji-icon mapping conventions, and the community header pattern that all screens must follow.

## Community Header Pattern (Mandatory)

All Community pages must use a 3-card header layout:

1. **Left Card (flex-1)**: Welcome message with page title and description
2. **Middle Card (w-32)**: Autopilot widget showing pending actions with badge counter, hover preview
3. **Right Card (w-32)**: Vitana Index showing circular score (742), navigates to health index page

All cards share glass morphism styling: `bg-white/80 backdrop-blur-sm rounded-2xl p-8 shadow-lg border border-white/20`. Deviations from this pattern are considered breaking changes requiring design system team approval.

## Universal Screen Pattern

Every screen in the VITANA application must follow a mandatory structure validated across 22 screens (Home-5, Community-8, Health-5, Wallet-4). CTO-approved, no exceptions.

**10 Required Components:**
1. **SEO** -- Title, description, canonical URL
2. **AppLayout** -- Main application wrapper
3. **SubNavigation** -- Section navigation tabs
4. **StandardHeader** -- Title with emoji at end (e.g., "Track your wellness journey ✨")
5. **UtilityActionButton** -- Search + action container
6. **SplitBar** -- Tab navigation system (max 3-4 tabs)
7. **withScreenId** -- Analytics tracking HOC
8. **Background gradient** -- `bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 min-h-screen`
9. **Plus icon** -- In all action buttons
10. **size="sm"** -- On all action buttons

**Grid System**: 12-column grid with standard patterns (6+3+3, 3+3+6, 12, 3+3+3+3).

## Horizontal List Patterns

Two card variants with locked dimensions:

### StandardHorizontalCard (Text-Only)
- min-h: 88px, px-4 py-3, gap-3, rounded-xl
- Icon/Avatar (36px), Title (15px/semibold, 2-line clamp), Description (13.5px, 2-line clamp)
- Hover: 2px accent rail, shadow-xl, 200ms ease-out
- Expandable with aria-expanded support

### VisualHorizontalCard (Image-Heavy)
- min-h: 100px, image at 36% width on desktop
- Fixed h-[100px] image with object-cover (prevents CLS)
- Category badge overlays image top-left
- No inline expansion (opens modal/page instead)

### HorizontalCardList Container
- Virtualization at 30+ items (disabled when any card expanded)
- Infinite scroll with 600px rootMargin
- Grouping and single-open expansion

**Analytics events**: `horizontal_list_view`, `horizontal_card_view`, `horizontal_card_expand`, `horizontal_card_cta`, `horizontal_list_load_more`. Privacy: never log names, emails, message content, or biomarker values.

**SLOs**: TTI <2000ms, interaction <200ms, infinite scroll <500ms, accessibility score >=95%.

### QA Checklist
The horizontal lists have a comprehensive QA checklist covering visual/layout, interactions, data/analytics, performance SLOs, accessibility (keyboard, screen reader, Axe DevTools), RTL/i18n, and visual regression testing. Feature flags control rollout via `enableHorizontalCardsReminder` and `enableHorizontalCardsTimeline`.

## Domain Accent Colors

| Domain | Accent Color Token |
|--------|-------------------|
| Health | `hsl(var(--pill-mental))` |
| Hydration | `hsl(var(--pill-hydration))` |
| Exercise | `hsl(var(--sys-warning))` |
| Sleep | `hsl(var(--primary))` |
| Default | `hsl(var(--accent))` |

## Emoji-Icon Mapping

VITANA uses a standardized emoji-icon system for SplitBar navigation across the entire platform.

**Key conventions:**
- Emoji icons precede text labels (e.g., "🏠 Overview")
- Page-level navigation (SplitBar/Tabs) uses emoji icons
- Modal/popup navigation uses Lucide icons to distinguish hierarchy
- Single space between emoji and text

**Common patterns:**
| Icon | Meaning |
|------|---------|
| 🏠 | Home, Overview, Dashboard |
| ⚙️ | Settings, Configuration |
| 📊 | Analytics, Data, Activity |
| 🔍 | Search, Traces, Lookup |
| 💰 | Money, Costs, Earnings |
| 🏆 | Achievements, Rankings |
| 👥 | Users, Community, Groups |

Comprehensive mapping covers Settings (Billing, Connected Apps, Preferences, Privacy, Support), Dev Hub (Auth, Flags, Tenants, Dashboard, Agents, CI/CD, etc.), Memory (Diary, Recall), and all main application pages.

## Validation and Enforcement

- Code reviews must validate against the 10-point checklist
- TypeScript interfaces for pattern compliance
- Automated testing in CI/CD
- Any deviation is a breaking change requiring CTO sign-off

## Related Pages

- [[mobile-pwa-architecture]] -- Mobile PWA rules and patterns
- [[screen-registry]] -- All 551+ screens following these patterns
- [[maxina-orb]] -- The ORB component visual requirements

## Sources

- `raw/design-system/UI_PATTERNS.md`
- `raw/design-system/emoji-icon-mapping.md`
- `raw/design-system/horizontal-list-patterns.md`
- `raw/design-system/HORIZONTAL_LISTS_QA.md`
- `raw/screen-registry/UNIVERSAL_SCREEN_PATTERN.md`

## Last Updated

2026-04-12
