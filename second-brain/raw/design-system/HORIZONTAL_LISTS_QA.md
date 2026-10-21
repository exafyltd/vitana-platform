# Horizontal Lists Unification - QA Checklist

## 🚀 Quick Start

The horizontal lists feature is now enabled in **development mode** by default. To test:

1. Navigate to `/inbox/reminder` or `/memory` (Timeline tab)
2. Open browser console to see analytics and SLO logs
3. Follow the checklist below

## ✅ QA Checklist

### Reminder Page (`/inbox/reminder`)

#### Visual & Layout
- [ ] Cards render full-width with proper spacing (gap: md = 1rem)
- [ ] Glass morphism effect visible (backdrop-blur, border-white/20)
- [ ] Hover reveals CTAs with smooth opacity transition
- [ ] Accent border shows on left side (hsl(var(--domain-messages-accent)))
- [ ] Test consent item has privacy badge with amber warning color

#### Interactions
- [ ] Click anywhere on card to expand/collapse
- [ ] Enter key expands card
- [ ] Esc key collapses card
- [ ] Quick replies appear in expanded state
- [ ] Primary "Mark Done" button shows on hover
- [ ] Secondary actions (Snooze, Edit, Delete) in dropdown menu
- [ ] Test consent item triggers HealthConsentGate dialog
- [ ] Consent dialog shows HIPAA warnings
- [ ] Action executes ONLY after clicking "I Consent"

#### Data & Analytics
- [ ] Cards grouped by Today/Yesterday/This Week/Older
- [ ] Timestamps display relative time (e.g., "2h ago")
- [ ] Analytics events logged in localStorage (`g1_analytics_events`)
- [ ] Check for events: `horizontal_card_view`, `horizontal_card_expand`, `horizontal_card_cta`
- [ ] NO PII/PHI in events (no names, emails, message content)

#### Performance (SLO)
- [ ] TTI < 2000ms (check console: `[SLO Met] TTI: Xms ✓`)
- [ ] Card interaction < 200ms (expand/collapse feels instant)
- [ ] Smooth animations at 60 FPS

---

### Timeline Page (`/memory` → Timeline tab)

#### Visual & Layout
- [ ] Cards render with proper icon badges (AI = purple, Diary = blue)
- [ ] Items grouped by Today/Yesterday/This Week/Older
- [ ] Sticky date headers remain visible on scroll
- [ ] Confidence scores display for AI insights
- [ ] Tags show in expanded state if present

#### Interactions
- [ ] Expand shows full content + tags
- [ ] Primary "Open" button shows on hover
- [ ] Secondary actions: "Save as Knowledge" (AI only), "Delete"
- [ ] Infinite scroll loads more items when scrolling to bottom
- [ ] Loading skeleton shows while fetching

#### Virtualization (if ≥30 items)
- [ ] DOM count stays stable (check DevTools Elements panel)
- [ ] Smooth scrolling with no janky behavior
- [ ] Items render/unmount as you scroll

#### Data & Analytics
- [ ] Knowledge items transform correctly
- [ ] Analytics events logged: `horizontal_list_load_more` on scroll
- [ ] NO PII/PHI in events

#### Performance (SLO)
- [ ] TTI < 2000ms
- [ ] Infinite scroll latency < 500ms
- [ ] SLO logs show green checkmarks

---

## 🔍 Accessibility (Both Pages)

### Manual A11y Testing

1. **Keyboard Navigation**
   - [ ] Tab key moves focus between cards
   - [ ] Enter key expands/collapses focused card
   - [ ] Esc key collapses expanded card
   - [ ] Focus visible on all interactive elements

2. **Screen Reader**
   - [ ] Cards announce as "article"
   - [ ] Expanded state announced (`aria-expanded`)
   - [ ] Button labels clear and descriptive

3. **Axe DevTools** (Install browser extension)
   - [ ] Run scan on both pages
   - [ ] Score ≥ 95%
   - [ ] Zero critical/serious violations

4. **Lighthouse Audit**
   - [ ] Accessibility score ≥ 95
   - [ ] Best Practices score ≥ 90
   - [ ] Performance score ≥ 80

---

## 🌍 RTL/i18n Testing

### Manual RTL Testing

1. Enable RTL mode in browser console:
   ```javascript
   document.documentElement.dir = 'rtl';
   ```

2. Check:
   - [ ] Text truncation still works
   - [ ] Icons positioned on right side
   - [ ] Accent border on right side
   - [ ] No horizontal scroll issues
   - [ ] Keyboard navigation unchanged
   - [ ] CTAs and badges aligned correctly

3. Reset:
   ```javascript
   document.documentElement.dir = 'ltr';
   ```

---

## 📊 Analytics Verification

### Check localStorage Events

Open browser console and run:

```javascript
// View all horizontal card events
const events = JSON.parse(localStorage.getItem('g1_analytics_events') || '[]');
console.table(events.filter(e => e.eventName.includes('horizontal')));

// Check for PII/PHI (should be FALSE)
const hasPII = events.some(e => {
  const payload = JSON.stringify(e.payload);
  return payload.includes('@') || // emails
         payload.includes('Dr. ') || // names
         /\d{3}-\d{3}-\d{4}/.test(payload); // phones
});
console.log('Contains PII/PHI:', hasPII); // Should be FALSE ✓
```

### Expected Events

- `horizontal_card_view` - fires when 50% of card visible
- `horizontal_card_expand` - fires on expand toggle
- `horizontal_card_cta` - fires on primary/secondary CTA click
- `horizontal_list_load_more` - fires on infinite scroll trigger

---

## ⚡ SLO Verification

### Check SLO Report

After interacting with pages, run in console:

```javascript
// Get SLO report
const { horizontalCardsSLO } = await import('./src/lib/horizontal-cards-slo.ts');
console.log('SLO Report:', horizontalCardsSLO.getReport());
console.log('All SLOs Pass:', horizontalCardsSLO.passesAllSLOs());
```

### Expected Output

```
[SLO Met] TTI: 1847ms ✓ (< 2000ms)
[SLO Met] Card interaction: 142ms ✓ (< 200ms)
[SLO Met] Infinite scroll: 389ms ✓ (< 500ms)
[SLO Met] A11y score: 97% ✓ (≥ 95%)
[SLO Met] Critical violations: 0 ✓
```

---

## 🎨 Visual Regression

### Compare Screenshots

Take screenshots of:

1. **Reminder - Collapsed State**
2. **Reminder - Expanded with Quick Replies**
3. **Reminder - Consent Gate Dialog**
4. **Timeline - Grouped by Date**
5. **Timeline - Expanded with Tags**
6. **Timeline - Infinite Scroll (60+ items)**

### Design System Compliance

- [ ] Glass effect matches other cards
- [ ] Shadows and borders consistent
- [ ] Badges and icons properly styled
- [ ] Spacing follows 4px/8px grid
- [ ] Colors use semantic tokens (no hardcoded values)

---

## 🔧 Feature Flags

### Development Mode (Current)

```typescript
// Automatically enabled in dev mode
enableHorizontalCardsReminder: import.meta.env.DEV // true
enableHorizontalCardsTimeline: import.meta.env.DEV // true
```

### Staging/Production Mode

Set environment variable:

```bash
# .env.local (staging)
VITE_FEATURE_HORIZONTAL_CARDS_ENABLED=true
```

---

## 🚨 Rollback Plan

If issues are found:

1. Set flags to `false` in `src/lib/feature-flags.ts`:
   ```typescript
   enableHorizontalCardsReminder: false,
   enableHorizontalCardsTimeline: false,
   ```

2. Old implementation will be used as fallback (no downtime)

3. Fix issues and re-test before re-enabling

---

## 📝 Notes

- **Test consent item** is only visible on Reminder page (ID: `consent-test-001`)
- **Virtualization** auto-enables at ≥30 items
- **Feature flags** work independently (can enable one without the other)
- **Analytics** uses existing `g1_analytics_events` infrastructure

---

## ✅ Sign-Off

- [ ] All visual tests passed
- [ ] All interaction tests passed
- [ ] All accessibility tests passed
- [ ] All RTL tests passed
- [ ] All analytics verified (no PII/PHI)
- [ ] All SLOs met
- [ ] No visual regressions
- [ ] Ready for staging deployment

**Tester Name:** ________________  
**Date:** ________________  
**Browser(s):** Chrome / Firefox / Safari  
**Device(s):** Desktop / Mobile
