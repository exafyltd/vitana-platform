# Vitana Design System

> **Canonical, reuse-only.** This file is a pure catalog of primitives that **already exist** in the codebase. It is the single source of truth for every UI decision across Vitana. Whenever this document and a file disagree, the file wins — update this document to match, not the other way around.
>
> This file is mirrored at `vitana-platform/DESIGN.md` and `vitana-v1/DESIGN.md`. Changes require a cross-repo sync PR.

## Two tracks, one contract

Vitana has two frontends with intentionally different visual languages:

| Track | Scope | Tech | Mode |
| --- | --- | --- | --- |
| **A — Command Hub** | Operator console (internal) | Vanilla JS + CSS custom properties | Dark-only |
| **B — vitana-v1 (community / admin / staff / professional / patient)** | User-facing app | React + Vite + Tailwind + shadcn/ui | Light + dark |

Tracks share the **same rules** (reuse, no invention, cite a template) but resolve to **different primitives**. Every component rule below is scoped to its track.

## Global rules (binding in both tracks)

1. **Reuse before create.** Every token, class, and component listed here already exists. If you need something new, update this document first — and document only what you added to the codebase, not what you wish existed.
2. **No new CSS variables, classes, components, type scales, or spacing scales.** If a value isn't in the catalog, it's drift.
3. **Cite on deviation.** If a screen diverges from the template, the PR description must cite the exact §-number here explaining why.
4. **Prefer implementation over recommendation.** When in doubt, pick a template screen, copy it, and ship.
5. **Accessibility is non-negotiable.** WCAG 2.2 AA contrast, visible focus ring, ≥44 px touch targets, respect `prefers-reduced-motion`.

---

# Track A — Command Hub

Location: `services/gateway/src/frontend/command-hub/`
Entry: `index.html` → `styles.css` + `app.js` (+ `intelligence-panels.js`, `navigation-config.js`, `orb-widget.js`)
Rendering: vanilla JS. `_renderAppCore()` replaces `root.innerHTML` on every state change. `showToast()` triggers `renderApp()` — always update button/state **before** calling `showToast()` or DOM refs detach (see `CLAUDE.md` memory for the full pattern).

## §A.1 Color tokens

All defined at `:root` in `styles.css:1–36` and `:5136–5162`. These are the **only** colors the Command Hub may use. Do not declare new ones. Do not hardcode hex.

### Surface + text
| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#0f172a` | Page background |
| `--color-sidebar-bg` | `#1e293b` | Sidebar, card/panel surface |
| `--color-border` | `#334155` | Borders, dividers |
| `--color-text-primary` | `#f8fafc` | Primary text |
| `--color-text-secondary` | `#94a3b8` | Muted/secondary text |

### Accent
| Token | Value | Use |
| --- | --- | --- |
| `--color-accent` | `#3b82f6` | Primary CTA, interactive accent |
| `--color-accent-hover` | `#2563eb` | Hover state |
| `--color-operator` | `#f59e0b` | **Reserved** for button variants only. Pills use neutral per SPEC-01 (`.header-pill--operator` is deprecated — see §A.5). |

### Task status
| Token | Value | Use |
| --- | --- | --- |
| `--color-task-scheduled` | `#60a5fa` | Scheduled rail/pill |
| `--color-task-progress` | `#f59e0b` | In-progress rail/pill |
| `--color-task-completed` | `#10b981` | Completed rail/pill |

### Layout
| Token | Value |
| --- | --- |
| `--sidebar-width` | `260px` |
| `--sidebar-collapsed-width` | `64px` |
| `--header-height` | `60px` |

### Overview panels
`--overview-grid-gap 0.45rem`, `--overview-panel-padding 0.6rem 0.7rem`, `--overview-panel-radius 8px`.

### Metric cards
`--metric-card-min-height 108px`, `--metric-card-padding 0.75rem 0.5rem`, `--metric-value-size 1.35rem`, `--metric-label-size 0.66rem`, `--metric-subtitle-size 0.58rem`.

### Health cards
`--health-card-padding 6px 8px`, `--health-card-font-size 0.72rem`, `--health-card-bg rgba(30,41,59,0.55)`, `--health-card-border rgba(148,163,184,0.16)`, `--health-card-border-hover rgba(148,163,184,0.32)`.

### Orb
`--orb-outer / -mid / -core / -highlight / -glow / -size-idle / -size-large / -z-idle / -z-overlay / -z-drawer`. State glows: `--orb-glow-{ready, listening, thinking, speaking, paused, connecting, error}`. Aura opacity / radius / intensity per state. See `styles.css:5136–5162`.

### Appilix (ORB integration)
`--appilix-bottom-nav-height 72px`, `--appilix-bottom-nav-h`, `--orb-gap 4px`.

## §A.2 Typography

- **Font family** (fixed): `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`.
- **Font size — permitted rem values only**: `0.58 / 0.65 / 0.66 / 0.7 / 0.72 / 0.75 / 0.85 / 0.9 / 0.95 / 1 / 1.1 / 1.25 / 1.35 / 1.5 / 1.75 / 2 rem`. If your value isn't on this list, you're introducing drift — pick the nearest one. Do not use pixel values. Do not use `style="font-size:…px"`.
- **Font weight**: 400 (regular), 500 (medium), 600 (semibold), 700 (bold). No other weights.
- **Letter-spacing**: only `0.5px` on uppercase pills (e.g. `.header-pill`, `.status-live`), and `0.05em` on metric labels. Nowhere else.

## §A.3 Spacing

Command Hub uses ad-hoc rem bands. The **permitted** set (observed across every canonical class):
`0.25 / 0.35 / 0.4 / 0.45 / 0.5 / 0.6 / 0.7 / 0.75 / 0.8 / 1 / 1.25 / 1.5 rem`.
Padding, gap, margin must fall on these values. No pixel values (except the three token-defined `6px / 8px / 16px` paddings on health/overview/orb primitives). No `style="padding:…px"`.

## §A.4 Radius, borders, shadows

- **Radius**: observed values are `6px`, `8px`, `12px`, `999px` (pill). Use only these. `--overview-panel-radius: 8px` is the canonical card radius.
- **Border**: `1px solid var(--color-border)` on all surfaces. Status-rail accents use `4px` left border.
- **Shadows**: defined inline on canonical surfaces (`.task-card`, `.modal`, `.toast`). Never hardcode a new box-shadow.

## §A.5 Canonical component templates — every new screen MUST copy one of these

### §A.5.1 Task Card
- **CSS**: `styles.css:483–558`
- **Render reference**: `app.js:6468–6590` (inside `renderTasksView`)
- **Classes**: `.task-card`, `.task-card-enhanced`, `.task-card-title`, `.task-card-vtid-label`, `.task-card-status-pill`, `.task-card-status-pill-{scheduled,in-progress,completed}`
- **Apply to**: any list of entities with status (approvals, agents registry, memory garden, pipelines)
- **Do**: attach status via `[data-status="scheduled|in-progress|completed"]`, never inline a color
- **Do not**: wrap in a custom `<div style="padding:…">` — the class owns padding

### §A.5.2 Header Pill
- **CSS**: `styles.css:1074–1220`
- **Classes**: `.header-pill`, `.header-pill--neutral`, `.header-pill--live`, `.header-pill--offline`, `.header-pill--warning`, `.header-pill-badge`
- **Apply to**: operator console header, live console tabs, Voice LAB status indicators, AUTOPILOT + OPERATOR pills
- **Do**: use `--neutral` for OPERATOR and AUTOPILOT per SPEC-01 (already the case at `app.js:5289, 5387`)
- **Deprecated (must not use, to be deleted)**: `.header-pill--operator`, `.header-button--operator`

### §A.5.3 Metric Card
- **CSS**: `styles.css:16758–16769`
- **Classes**: `.metric-card`, `.metric-label`, `.metric-value`, `.metric-sub`, `.metric-ok`, `.metric-warn`, `.metric-error`
- **Sizes** (fixed via tokens): label `0.66rem` uppercase 0.05em letter-spacing, value `1.35rem` weight 700, sub `0.58rem` secondary color
- **Apply to**: every KPI / stat / overview tile in every dashboard view

### §A.5.4 Status Live chip
- **CSS**: `styles.css:128–141`
- **Class**: `.status-live`
- **Spec**: `0.75rem`, weight 600, uppercase, `0.5px` letter-spacing, `0.35rem 0.75rem` padding, pulse-animated dot
- **Apply to**: diagnostics, Voice LAB, any "LIVE" indicator

## §A.6 Other existing primitives (reuse, do not replace)

- **Buttons**: `.btn` (neutral), `.btn-primary` (solid accent), `.header-button`, `.header-button--primary`. Height 32px for header buttons.
- **Modals**: `.modal-overlay` + `.modal` — 500px wide, `#1e293b` bg, 8px radius, backdrop blur 2px. See `styles.css:626–652`.
- **Drawers**: `.task-drawer` — fixed right 450px, `transition: right 0.3s`, slides via `state.showTaskDrawer` flag. Do **not** inline-style a second drawer.
- **Toasts**: `.toast-container`, `.toast` — bottom-right, z-index 3000, 3px left-border color by type, `toast-slide-in` animation. State-driven via `state.toasts` + `renderApp()` — see button-pattern rule in `CLAUDE.md`.
- **Overview panel**: `.overview-panel` — use for grouped metric-card clusters.
- **Approvals badge**: `.approvals-badge` — red, `9px` radius.

## §A.7 Motion

- **Default transition**: `0.2s` ease or `0.3s` ease-out (already used on existing components). No new durations.
- **Animations in use**: `toast-slide-in`, `.status-live` pulse dot (2s infinite), `.task-drawer` slide-in.
- **Reduced motion**: respect `prefers-reduced-motion: reduce`. Do not add new keyframes without a documented reason.

## §A.8 Layout

- **Fixed sidebar** (`--sidebar-width 260px` / collapsed `64px`).
- **No responsive breakpoints** — Command Hub is desktop-only by design.
- **Main content**: flex column, `overflow-hidden`, scrollable regions use `flex: 1`.
- **Header**: flex row `space-between`, left = nav, right = pills + buttons.

## §A.9 Reference renderers (copy these, don't reinvent)

| View | Location | What to copy |
| --- | --- | --- |
| Tasks board | `app.js:6230` `renderTasksView` | Column + task-card layout, status pill usage |
| Operator task queue | `app.js:29519` `renderOperatorTaskQueueView` | Header-pill usage, metric-card cluster |
| Operator dashboard | `app.js:29735` `renderOperatorDashboardView` | Full metric-card grid |
| Approvals | `app.js:21881` `renderApprovalsView` | Task-card + status-pill for action items |
| Live console | `app.js:30773` `renderCommandHubLiveConsoleView` | Header pills (live/offline), status-live chip |

## §A.10 Named anti-patterns — migrate to the templates above

| File | Lines | Violation | Migrate to |
| --- | --- | --- | --- |
| `app.js` | 1080–1175 | Login form: `style.cssText` with `padding:40px`, `font-size:0.9rem` inline | `.btn` / `.btn-primary`; remove all inline font-size / padding |
| `app.js` | 7029–7034 | Approval banners: `padding: 12px 14px`, `font-size: 11px` inline | `.task-card` pattern + `.header-pill--warning` for the severity badge |
| `app.js` | 15435–15452 | Governance violation badges: inline `padding:0.25rem 0.5rem;font-size:0.7rem` | `.task-card-status-pill` |
| `app.js` | 20659–20750 | Memory Garden columns without backing classes | `.task-card` / `.metric-card` |
| `app.js` | 23288–23313 | Debug modal: `style.cssText = 'padding: 16px 20px'` | `.modal` / `.modal-overlay` (`styles.css:626–652`) |
| `app.js` | 32232–32276 | Debug Panel rows: inline `font-size:0.85rem` inside `innerHTML` | `.metric-card` / `.metric-label` / `.metric-value` |
| `styles.css` | 10588–10704 | Unified Intelligence: raw `16px` / `12px` / `13px` font sizes; parallel tokens `--card-bg`, `--text-primary`, `--text-muted`, `--accent-color`, `--border-color` that collide with root `--color-*` | Replace refs with root `--color-*`; normalize font sizes onto §A.2 list |
| `styles.css` | 12022–12051 | Agents Registry: `padding: 16px 24px` (mixed pixels) | Use rem values from §A.3; wrap list items in `.task-card` |

## §A.11 Command Hub "do not" list

- Never write `style="font-size:NNpx"` or `style.cssText = "…font-size:NNpx…"`.
- Never write `style="padding:NNpx"` outside the documented health/overview/orb tokens.
- Never declare a new `--*` variable. Reuse `--color-*`.
- Never bring back `.header-pill--operator` or `.header-button--operator`.
- Never introduce a new toast/drawer/modal mechanism — use the existing state-driven ones.
- Never call `showToast()` before updating the button/state — see the pattern rule in `CLAUDE.md`.

---

# Track B — vitana-v1 (community / admin / staff / professional / patient)

Location: `/home/dstev/vitana-v1/` (separate repo — `exafyltd/vitana-v1`)
Tech: React 18 + TypeScript, Vite 5 (SWC), Tailwind CSS 3 + shadcn/ui, Zustand, TanStack React Query v5, Radix UI primitives.
Dark mode: class-based (`darkMode: ["class"]` in `tailwind.config.ts:4`).
Deployment: Cloud Run `community-app` (main → production). Preview at `https://community-app-q74ibpv6ia-uc.a.run.app/`.

## §B.1 Color tokens (HSL)

All 150+ tokens live in `src/index.css:1–293` under `:root` (light) and `.dark` (dark). Tailwind classes reference them via `hsl(var(--token))` in `tailwind.config.ts:31–178`. These are the **only** colors vitana-v1 may use. Do not hardcode Tailwind palette classes like `bg-gray-300`, `bg-red-600`, `text-blue-500` — they bypass dark-mode remapping and tenant branding.

### Shadcn base (semantic)
`--background`, `--foreground`, `--card(-foreground)`, `--popover(-foreground)`, `--primary(-foreground)`, `--secondary(-foreground)`, `--muted(-foreground)`, `--accent(-foreground)`, `--destructive(-foreground)`, `--border`, `--input`, `--ring`. Use via Tailwind: `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, `bg-destructive`, etc.

### Sidebar
`--sidebar-{background, foreground, primary, primary-foreground, accent, accent-foreground, border, ring}`. Reference via `tailwind.config.ts:65–74`.

### Pillars (5 longevity pillars)
`--pill-{nutrition, hydration, mental, exercise, sleep}-{accent, tint}`. Classes: `bg-pill-nutrition-accent`, `bg-pill-nutrition-tint`, etc.

### Systems (3)
`--sys-{vitana, autopilot, ai}-{accent, tint}`.

### Utilities (3)
`--util-{calendar, settings, profile}-{accent, tint}`.

### Domains (6)
`--domain-{discover, health, tracker, messages, messages-bubble, community}-{accent, tint}` (+ `messages-bubble-foreground`).

### Calendar
`--calendar-{primary, primary-light, secondary, accent, success, background, card, gradient-start, gradient-end}`.

### Health
`--health-{primary, success, warning, danger}`.

### Brand (tenant-overridable)
`--brand-{accent, bg, fg, live}`. `--brand-live` is the diary/live streaming color. Declared at `src/index.css:145`. (Note: normalized to HSL triplet per the DESIGN.md convention — same hue, same value.)

### Action gradients (5)
`--gradient-{join, follow, play, disabled, vitana}-{start, end}`.

### Profile exclusive
`--profile-{bg-start, bg-end, accent-teal, accent-indigo, glass-light, text-primary, text-secondary, text-tertiary}`.

### Contact import
`--contact-{sync-accent, sync-tint, glass-bg, card-radius, source-google, source-apple, source-phone, source-whatsapp, success, warning}`.

### Misc
`--ruby` (streaming red for diary), `--appilix-bottom-nav`, `--orb-gap`, `--comm-dock-h`, `--composer-h`, `--row-base`, `--grid-gap`, `--radius`, `--contact-card-radius`.

## §B.2 Typography

- **Sans**: system default (Tailwind's stack). No font-family overrides in new components.
- **Editorial**: `fontFamily.editorial: ['Cormorant', 'Georgia', 'serif']` (`tailwind.config.ts:28–30`). **Reserved** for branded marketing headings — not general UI copy.
- **Font sizes**: Tailwind's default scale only (`text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`, ...). No custom sizes. No arbitrary `text-[13px]`.
- **Font weights**: Tailwind's `font-{thin|extralight|light|normal|medium|semibold|bold|extrabold|black}`. No numeric arbitrary weights.

## §B.3 Spacing

- **Scale**: Tailwind default (`p-0`, `p-0.5`, `p-1`, `p-1.5`, `p-2`, `p-3`, `p-4`, `p-5`, `p-6`, `p-8`, `p-10`, `p-12`, `p-16`, `p-20`, `p-24`, ...). No extensions.
- **Layout tokens** (already defined): `--grid-gap 1.5rem`, `--row-base 70px`, `--comm-dock-h 72px`, `--composer-h 112px`, `--appilix-bottom-nav 84px`, `--orb-gap 10px`.
- **Never** use arbitrary pixel values in JSX: `className="px-[13px]"`, `style={{ padding: '17px' }}`, etc.

## §B.4 Radius, borders, shadows

- **Radius**: derived from `--radius: 0.5rem` via `tailwind.config.ts:180–184` — `rounded-lg`, `rounded-md`, `rounded-sm`. Larger: `rounded-xl`, `rounded-2xl` (Tailwind defaults). Contact cards: `var(--contact-card-radius)` = `1rem`.
- **Borders**: `border`, `border-border`, `border-input` — never a hex color.
- **Shadows**: Tailwind defaults (`shadow-sm`, `shadow`, `shadow-md`, `shadow-lg`, `shadow-xl`). No custom box-shadow.

## §B.5 Grid & responsive

- **Breakpoints** (`tailwind.config.ts:13–19`): `sm 640 / md 1024 / lg 1280 / xl 1536 / 2xl 1600`. Use only these.
- **Container**: `max-w-7xl mx-auto` is the standard page width for all role dashboards. `max-w-2xl` and below are for modals/forms only.
- **Mobile-first**: stack; reveal desktop layout at `lg:`. Use the `useIsMobile()` hook when JSX diverges.

## §B.6 MANDATORY SCREEN CONTRACT

Every non-auth screen MUST render this tree. Already codified in `docs/UI_PATTERNS.md` and `docs/UNIVERSAL_SCREEN_PATTERN.md` — this is the binding restatement.

```tsx
<AppLayout>
  <SEO title="…" description="…" />
  <SubNavigation items={<role|domain>Navigation} />
  <div className="p-6 min-h-screen pb-24">
    <div className="max-w-7xl mx-auto space-y-6">
      <StandardHeader title="…" emoji="…" subtitle="…" />
      <UtilityActionButton>
        <ExpandableSearchButton … />
        <UniversalCalendarButton />
        {/* domain-specific action buttons go here as children */}
      </UtilityActionButton>
      <SplitBar …>{/* only when 2+ sections */}</SplitBar>
      {/* page content */}
    </div>
  </div>
</AppLayout>
```

**Rules**:
- `max-w-7xl` — not `max-w-2xl`, not `max-w-5xl`.
- Outer: `p-6 min-h-screen pb-24`. Inner: `max-w-7xl mx-auto space-y-6`.
- Background: `bg-background` or the documented gradient. Do **not** invent gradients (e.g. `bg-gradient-subtle`, `bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50` outside the documented community-header pattern).
- **Search lives only inside `UtilityActionButton`.** No inline `<Input>` search elsewhere in the page.
- Mobile: `StandardHeader` collapses to a single `<h1>`; `UtilityActionButton` still renders.

### §B.6.1 StandardHeader (3-card)
File: `src/components/StandardHeader.tsx`. Desktop renders three cards: **Welcome** (flex-1, title + emoji + subtitle + optional sync timestamp), **Autopilot** (`w-32`, cursor-pointer with Badge at `-top-2 -right-2`), **Vitana Index** (`w-32`, navigates to `/health`). Each card: `bg-card rounded-2xl p-6 shadow-xl border border-white/20`. Mobile collapses to one `<h1>Title emoji</h1>`. See `docs/UI_PATTERNS.md` for the canonical community variant.

### §B.6.2 UtilityActionButton (the one action bar)
File: `src/components/ui/utility-action-button.tsx`. Ordered left-to-right: `{children} → LifeCompass → GiftVoucher → afterGiftVoucherChildren → trailingElement`. Container: `flex gap-2.5 items-center overflow-x-auto py-2`.

**Props**: `children` (custom actions), `className?`, `hideGiftVoucher?`, `hideLifeCompass?`, `trailingElement?`, `afterGiftVoucherChildren?`, `compact?`.

**Do**:
- Put domain actions (New, Filter, Export) in `children`.
- Put overflow chips (`MobileModePill`, `VitanaIndexChip`, `AutopilotChip`) in `afterGiftVoucherChildren`.
- Use `hideGiftVoucher` / `hideLifeCompass` when needed.

**Do not**:
- Restructure the container.
- Render actions outside this component.
- Inline a second row of buttons for "secondary" actions — the overflow scroll handles it.

## §B.7 Canonical reference screens — new screens MUST copy one

### §B.7.1 Baseline single-section: `src/pages/Sharing.tsx:1–87`
Uses the full chain: `AppLayout → SEO → SubNavigation → StandardHeader → UtilityActionButton (search + calendar + New Campaign)`. Copy this for any screen with one main content area.

### §B.7.2 Multi-section with tabs: `src/pages/Health.tsx:1–79`
Adds `SplitBar` after `UtilityActionButton` for tabbed content. Copy this for role dashboards with 2+ sections.

### §B.7.3 Mobile-first with overflow chips: `src/pages/Home.tsx:14–67`
Uses `afterGiftVoucherChildren` for `MobileModePill` + `VitanaIndexChip` + `AutopilotChip`, and `useIsMobile()` for divergent JSX. Copy this only when mobile genuinely needs different chrome.

## §B.8 Component primitives (reuse, do not replace)

Location: `src/components/ui/` (86 files). Indexed by purpose — use these before creating anything.

| Purpose | Primitive |
| --- | --- |
| **Buttons** | `button`, `toggle`, `toggle-group`, `utility-action-button`, `expandable-search-button`, `right-actions` |
| **Inputs** | `input`, `textarea`, `inline-edit-input`, `pin-input`, `voice-recorder`, `emoji-picker` |
| **Selects** | `select`, `radio-group`, `checkbox`, `switch`, `slider` |
| **Cards** | `card`, `gradient-text`, `horizontal-card-list` (standard + visual variants), `stacked-card-list`, `clickable-avatar`, `popover-trigger-avatar` |
| **Tables / data-viz** | `chart` (recharts), `progress`, `split-bar`, `split-screen` |
| **Overlays** | `dialog`, `alert-dialog`, `drawer`, `sheet`, `popover`, `tooltip`, `hover-card`, `context-menu`, `dropdown-menu`, `menubar` |
| **Tabs / nav** | `tabs`, `navigation-menu`, `breadcrumb`, `pagination`, `sidebar`, `accordion` |
| **Badges / status** | `badge`, `alert`, `skeleton`, `loading-spinner`, `reward-dot`, `kbd` |
| **Media / misc** | `avatar`, `aspect-ratio`, `carousel`, `scroll-area`, `command`, `calendar`, `attachment-preview`, `search-filter-bar`, `virtualized-list`, `separator`, `label` |

Compose; don't fork. If a primitive doesn't fit, update this document and open a discussion — never quietly clone one into your screen.

## §B.9 List patterns (already codified)

See `docs/design-system/horizontal-list-patterns.md`:

- **StandardHorizontalCard**: `88px min-h`, `px-4 py-3`, `36px` avatar, `15px` title, 2-line clamp.
- **VisualHorizontalCard**: `100px min-h`, image 36% width × 100px height, image-first layout.
- Both: `rounded-xl`, `2px` left accent rail colored by domain, focus `ring-1 ring-[hsl(var(--accent))]/60`, `200ms ease-out`, infinite scroll `600px rootMargin`.

## §B.10 Motion

- Defaults: `tailwindcss-animate` + the keyframes in `tailwind.config.ts:185–245`: `accordion-down/up`, `scroll` (slow/medium/fast), `fade-in-up`, `gradient-x`, `shimmer`, `wave`, `fadeIn`.
- Default transition duration: `200ms ease-out`.
- **Do not** add `framer-motion` to new primitives (the dep exists for legacy features; new work goes through `tailwindcss-animate`).
- Respect `prefers-reduced-motion: reduce`.

## §B.11 Accessibility

- WCAG 2.2 AA contrast — all HSL token pairs already meet this; do not override `.dark` with lighter variants.
- Focus ring: `ring-1 ring-[hsl(var(--ring))]` or `focus-visible:ring-2 focus-visible:ring-ring` (shadcn default). Never remove focus outlines.
- Touch targets ≥ `44px` (`h-11 w-11` or larger).
- Screen-reader labels on icon-only buttons via `sr-only` span or `aria-label`.

## §B.12 Named anti-patterns — migrate to existing primitives

| File | Violation | Fix |
| --- | --- | --- |
| `src/pages/AutopilotDashboard.tsx:454–565` ("My Journey" desktop) | Skips `SubNavigation`, omits `UtilityActionButton`, uses `bg-gradient-subtle`, caps at `max-w-2xl`, wave cards without `SplitBar` | Wrap desktop branch in the §B.6 MANDATORY SCREEN CONTRACT using existing `AppLayout / SEO / SubNavigation / StandardHeader / UtilityActionButton`. Swap `max-w-2xl → max-w-7xl`. Drop `bg-gradient-subtle`. Optional: wrap waves in `SplitBar`. |
| `src/pages/discover/DealsOffers.tsx:489,492` | `bg-gray-300` + `bg-red-600` + inline `style={{ width: \`${pct}%\` }}` | Replace with `<Progress value={pct} />` from `src/components/ui/progress.tsx` |
| `src/pages/Community.tsx:~295` | Inline `style={{ minHeight: '280px' }}` | Replace with Tailwind class (e.g. `min-h-72`) |
| `src/index.css:145` | `--brand-live: #ff004f` (raw hex, bypasses `.dark` remap) | Normalize to HSL triplet format — same color, matches every other `--brand-*` |

## §B.13 vitana-v1 "do not" list

- No `bg-{gray,red,blue,green,yellow}-[0-9]{3}` — use semantic tokens (`bg-muted`, `bg-destructive`, `bg-primary`, `bg-pill-*`, `bg-domain-*`).
- No arbitrary Tailwind values like `w-[317px]`, `px-[13px]`, `text-[13px]`.
- No inline `style={{ padding: 'NNpx' }}` / `style={{ fontSize: 'NNpx' }}` / `style={{ minHeight: 'NNNpx' }}` — use classes or layout tokens.
- No new `--*` CSS variable. If it's not in §B.1, it doesn't exist.
- No new primitive under `src/components/ui/` without updating this document first.
- No decorative gradients outside the 5 documented action gradients and the community header pattern.
- No text smaller than `text-xs` (12 px).
- No search input outside `UtilityActionButton`.
- No `max-w-*` smaller than `7xl` on a role dashboard (modals/forms excepted).

---

# Shared rules (both tracks)

## §S.1 Brand principles & visual tone

Longevity. Clinical trust. Calm data density. We present complex, data-heavy screens without overwhelming the reader. Accent color is scarce and deliberate. Decoration never competes with information.

## §S.2 Do-not list (combined)

1. **Do not invent tokens, classes, components, scales.** If it's not in §A or §B, it doesn't exist.
2. **Do not hardcode hex colors.** Command Hub uses `--color-*`; vitana-v1 uses `hsl(var(--…))`.
3. **Do not use inline styles for font-size / padding / color / size.** Classes own visual properties.
4. **Do not redefine primitives locally** — e.g. a second "card" component, a competing toast, a custom drawer.
5. **Do not over-accent.** Every screen should have ≤ 1 primary accent region. The rest is neutral.
6. **Do not use decorative gradients** unless they're the 5 documented action gradients (vitana-v1 §B.1) or the community header pattern.
7. **Do not drop text below 12 px** (`text-xs` / `0.75rem`).
8. **Do not break focus visibility.**
9. **Do not deviate silently.** Any deviation MUST cite a §-number here in the PR description.
10. **Do not leave the repo half-migrated without documenting what remains.** See §S.4.

## §S.3 Deviation protocol

If a design *must* differ from this document:
1. State why in the PR description, citing §-number.
2. If the deviation is a one-off (e.g. a legal disclaimer screen), mark the file with a `/* design-exception: §… */` comment.
3. If the deviation should become the new standard, update this document in the same PR, in both repos. Never land a deviation that outlives the PR without the document catching up.

## §S.4 Migration status (as of 2026-04-22)

**Source of truth established**: this document + `CLAUDE.md` Section 17 (vitana-platform) / updated `CLAUDE.md` (vitana-v1).

**Completed in this PR (foundation)**:
- DESIGN.md written at both repo roots (identical content, two tracks inside).
- `vitana-platform/CLAUDE.md` Section 17 added — binding design-system rules.
- `vitana-v1/CLAUDE.md` amended — binding rules + MANDATORY SCREEN CONTRACT pasted in.
- Command Hub: `.header-pill--operator` and `.header-button--operator` deleted from `styles.css` (SPEC-01 had already marked them DO NOT USE; confirmed zero JS references).
- Command Hub: parallel tokens (`--card-bg`, `--text-primary`, `--text-muted`, `--accent-color`, `--border-color`) aliased at `:root` to the canonical `--color-*` tokens — the 59 legacy references now resolve through the canonical palette instead of their inline hex fallbacks.
- vitana-v1: `--brand-live` normalized from `#ff004f` to HSL triplet `341 100% 50%`; added to `.dark` block; consumer (`DiaryOrb.tsx`) updated to `bg-[hsl(var(--brand-live))]`.
- vitana-v1: `AutopilotDashboard.tsx` desktop branch wrapped in the MANDATORY SCREEN CONTRACT — `SubNavigation` added, `UtilityActionButton` added with search + calendar, `max-w-2xl → max-w-7xl`, `bg-gradient-subtle` removed.
- vitana-v1: `DealsOffers.tsx:483-495` progress bar now uses `<Progress>` from `components/ui/progress.tsx`; `bg-gray-100` → `bg-muted`.
- vitana-v1: `Community.tsx:797` inline `style={{ minHeight: '280px' }}` replaced with `min-h-72`.

**Command Hub audit**: the full 140-function drift inventory lives at [`docs/design-system/COMMAND_HUB_AUDIT.md`](docs/design-system/COMMAND_HUB_AUDIT.md) (generated 2026-04-23). It lists every render function by drift level, names the canonical class each should migrate onto, and sequences the work into four waves. Summary: 23 HIGH / 12 MEDIUM / 18 LOW / 87 CLEAN out of 140 audited.

**Deferred to follow-up issues** (per-file, per-track):
- Command Hub: migrate the 23 HIGH-drift render functions listed in the audit doc onto `.task-card` / `.metric-card` / `.header-pill` / `.status-live` / `.modal` / `.btn`. Each becomes a focused follow-up PR; the collision-alias in `styles.css:41–45` means the residual color drift displays correctly but per-function cssText/hex removal is still needed.
- Command Hub: normalize `styles.css:12022–12051` (Agents Registry) and `:10588–10704` (Unified Intelligence) hardcoded pixel font sizes onto the permitted rem set (§A.2).
- vitana-v1: per-role screen audit across community / admin / staff / professional / patient — each role's screens validated against the MANDATORY SCREEN CONTRACT.
- vitana-v1: full sweep of remaining raw Tailwind palette classes (`bg-gray-*`, `bg-red-*`, `bg-blue-*`, `bg-green-*`, `bg-yellow-*`, `text-red-*`, etc.) in `src/`.
- vitana-v1: consolidation of the dark-mode remap for `--profile-*` and `--contact-*` groups (currently both light and dark declare the same values — verify intent).

---

*Changes to this file require a cross-repo sync PR — keep `vitana-platform/DESIGN.md` and `vitana-v1/DESIGN.md` identical.*
