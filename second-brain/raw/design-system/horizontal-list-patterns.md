# Horizontal List Patterns - VITANA Design System

## Quick Decision Tree

```
Does the list item need an image?
├─ YES → Use VisualHorizontalCard
│   └─ Examples: AI Feed, Events, Health Journeys
│
└─ NO → Use StandardHorizontalCard
    └─ Examples: Messages, Activities, Logs, Knowledge Base
```

## Components

### StandardHorizontalCard
**Text-focused horizontal card** with icon, title, description, badges, and actions.

**Dimensions (LOCKED):**
- `min-h-[88px]` - Fixed minimum height
- `px-4 py-3` - Internal padding (16px horizontal, 12px vertical)
- `gap-3` - Spacing between cards (12px)
- `rounded-xl` - Corner radius (12px)

**Layout:**
- Icon/Avatar: 36px circle
- Title: 15px/semibold (2-line clamp)
- Description: 13.5px (2-line clamp)
- Metadata: 12px text
- Badges: 11px text, h-5, px-2

**States:**
- Hover: 2px accent rail (left), shadow-xl, border-accent/40, 200ms ease-out
- Focus: ring-1 ring-[hsl(var(--accent))]/60 (no outline jitter)
- Expansion: 200ms ease-out (Standard only), disabled on Visual cards

**Actions:**
- Primary: Right side, ghost variant → solid on hover
- Secondary: Kebab menu (DropdownMenu)

**A11y:**
- Structure: `<article>` > `<button>` (header) + `<region>` (expanded body)
- `aria-expanded`, `aria-controls`, `aria-labelledby` on expandable cards
- Keyboard: Enter/Space toggle (Standard only), Esc collapses, Tab order left→right
- Focus ring: ring-1 ring-[hsl(var(--accent))]/60, no outline jitter
- RTL: Accent rail + icon paddings flip to right

### VisualHorizontalCard
**Image-heavy horizontal card** with visual content, category badge, and status indicators.

**Dimensions (LOCKED):**
- `min-h-[100px]` - Fixed minimum height (unified with endless scroll impression)
- `px-4 py-3` - Internal padding (16px horizontal, 12px vertical)
- `gap-3` - Spacing between cards (12px)
- `rounded-xl` - Corner radius (12px)

**Layout:**
- Image: 36% width (≥1024px), stacked on smaller screens
- Image height: Fixed `h-[100px]` with centered `object-cover` (no aspect-ratio padding)
- Image treatment: `object-cover`, `rounded-t-xl lg:rounded-l-xl`, `lazy` loading
- Fixed height prevents CLS while maintaining endless scroll impression
- Category badge: overlays top-left inside media (z-10)
- Title: 15px/semibold (2-line clamp)
- Description: 13.5px (2-line clamp)
- Metadata: 12px text
- Badges: 11px text, h-5, px-2

**States:**
- Hover: 2px accent rail (left), shadow-xl, border-accent/40, image scale-105, 200ms ease-out
- Focus: ring-1 ring-[hsl(var(--accent))]/60 (no outline jitter)
- Motion: 200ms ease-out for all transitions

**Actions:**
- No inline expansion (Visual cards open modal/page on action)
- Primary CTA on the right side
- Secondary actions in kebab menu
- Category badge overlays image (top-left)
- Status dot and badge (right side column)

**A11y:**
- Structure: `<article>` > `<button>` (clickable card)
- Image alt text required
- Focus ring: ring-1 ring-[hsl(var(--accent))]/60, no outline jitter
- Keyboard: Tab to focus, Enter/Space to activate
- RTL: Accent rail + layout flip to right
- Dark mode: Uses semantic tokens only (no hardcoded colors)

### HorizontalCardList
**Container** with virtualization (≥30 items, disabled when any card expanded), infinite scroll (600px rootMargin), grouping, and single-open expansion.

### HorizontalCardSkeleton
**Loading state** for both patterns with shimmer animation, matching dimensions (Standard=88px, Visual=100px), same paddings (px-4 py-3), and gap-3. Shows 3-5 skeleton rows while loading. Fixed media height for Visual variant to prevent CLS.

## Analytics

**Events emitted:**
- `horizontal_list_view` - When list renders (on mount with itemCount)
- `horizontal_card_view` - When card becomes visible (50% IntersectionObserver threshold)
- `horizontal_card_expand` - When card expansion toggled (Standard only)
- `horizontal_card_cta` - When primary/secondary action clicked
- `horizontal_list_load_more` - When infinite scroll sentinel triggers (600px rootMargin, with newItemCount)

**Payload structure:**
```typescript
{
  variant: 'standard' | 'visual',
  screenId: string,
  cardId: string,
  listId?: string,
  actionId?: string,
  value?: string
}
```

**Privacy rules:**
- ✅ Log: IDs, screen IDs, action IDs, counts
- ❌ Never: Names, emails, message content, biomarker values

## Domain Accent Colors

**Accent rail colors (2px left border):**
- Health: `hsl(var(--pill-mental))`
- Hydration: `hsl(var(--pill-hydration))`
- Exercise: `hsl(var(--sys-warning))`
- Sleep: `hsl(var(--primary))`
- Default: `hsl(var(--accent))`

Use `category.color` prop to set domain-specific accent colors.

## Usage Examples

### Standard Pattern (Text-Only)

```typescript
import { HorizontalCardList } from '@/components/ui/horizontal-card-list';
import { StandardHorizontalCardProps } from '@/components/ui/standard-horizontal-card';

const items: StandardHorizontalCardProps[] = messages.map(msg => ({
  id: msg.id,
  screenId: 'D1-004-01',
  icon: '💬',
  title: msg.title,
  description: msg.content,
  badges: ['urgent'],
  timestamp: '2h ago',
  metadata: '3 replies',
  primaryAction: {
    label: 'Mark Done',
    onClick: () => handleDone(msg.id)
  },
  expandedContent: <div>Expanded details here</div>,
  density: 'compact'
}));

<HorizontalCardList
  items={items}
  variant="standard"
  screenId="D1-004-01"
  groupBy="date"
  gap="sm"
  infiniteScroll
/>
```

### Visual Pattern (With Images)

```typescript
import { HorizontalCardList } from '@/components/ui/horizontal-card-list';
import { VisualHorizontalCardProps } from '@/components/ui/visual-horizontal-card';

const items: VisualHorizontalCardProps[] = activities.map(activity => ({
  id: activity.id,
  screenId: 'AI_FEED_ACTIVITY',
  imageUrl: activity.image,
  imageAlt: activity.title,
  category: {
    icon: '💧',
    label: 'Health',
    color: 'hsl(var(--pill-hydration))'
  },
  title: activity.title,
  description: activity.description,
  motivationalHook: 'Great progress! 🎉',
  metadata: [
    { icon: <Award />, text: '7 day streak' },
    { icon: <TrendingUp />, text: '+25 pts' }
  ],
  statusBadge: {
    label: 'Completed',
    variant: 'default',
    icon: <CheckCircle />
  },
  timestamp: '2h ago',
  statusDot: 'completed',
  rewardPoints: 5,
  density: 'compact'
}));

<HorizontalCardList
  items={items}
  variant="visual"
  screenId="AI_FEED_ACTIVITY"
  listId="ai-feed-activity"
  groupBy="date"
  gap="sm"
/>
```

## Density

**Locked to compact** - No UI density toggle. density="compact" by default. Prop remains for dev use only.

## SLOs

- TTI < 2000ms
- Interaction < 200ms (200ms ease-out animations)
- Infinite scroll < 500ms (600px rootMargin for preloading)
- A11y score ≥ 95%
- Zero critical violations
- No CLS (reserved image heights)

## Feature Flags

Enable via `src/lib/feature-flags.ts` after validation.
