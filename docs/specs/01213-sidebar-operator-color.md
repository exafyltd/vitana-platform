# Specification: Sidebar Navigation Operator Color Consistency

**Ticket:** 01213
**Date:** 2026-01-24
**Status:** Draft

## Summary

The "Operator" navigation item in the sidebar currently appears in a distinct amber/orange color (`#f59e0b`), while all other navigation items use the default blue styling. This specification defines the changes required to make the Operator item visually consistent with all other sidebar navigation topics.

## Current Behavior

The Operator navigation item is styled differently from other sidebar items:

1. **Text Color:** Amber/orange (`#f59e0b`) instead of the default text color
2. **Active Border:** 3px amber left border when active, while other items use blue (`#3b82f6`)
3. **Targeting Mechanism:** CSS attribute selector `[data-module="Operator"]` applies special styling

### Affected Files

| File | Line(s) | Description |
|------|---------|-------------|
| `services/gateway/src/frontend/command-hub/styles.css` | 13 | Defines `--color-operator: #f59e0b` CSS variable |
| `services/gateway/src/frontend/command-hub/styles.css` | 253-270 | CSS rules targeting `[data-module="Operator"]` |
| `services/gateway/src/frontend/command-hub/app.js` | 4051 | Sets `data-module` attribute used for targeting |

### Current CSS (styles.css)

```css
/* Line 13 */
--color-operator: #f59e0b;

/* Lines 253-270 */
.nav-item[data-module="Operator"]::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background-color: var(--color-operator);
  display: none;
}

.nav-item[data-module="Operator"] {
  color: var(--color-operator);
}

.nav-item[data-module="Operator"].active::before {
  display: block;
}
```

## Required Changes

### Option A: Remove Operator-Specific Styling (Recommended)

Remove the CSS rules that give Operator special styling, allowing it to inherit the default navigation item styles.

**Changes to `services/gateway/src/frontend/command-hub/styles.css`:**

1. **Remove** the following CSS rules (lines 253-270):
   - `.nav-item[data-module="Operator"]::before { ... }`
   - `.nav-item[data-module="Operator"] { color: var(--color-operator); }`
   - `.nav-item[data-module="Operator"].active::before { ... }`

2. **Optionally remove** the `--color-operator` CSS variable from line 13 if it is not used elsewhere in the application.

### Option B: Keep Infrastructure, Override to Default

If the operator color infrastructure may be needed in the future, override with default values:

```css
.nav-item[data-module="Operator"] {
  color: inherit; /* Use default nav-item text color */
}

.nav-item[data-module="Operator"].active::before {
  background-color: var(--color-primary); /* Use default blue accent */
}
```

## Expected Behavior After Fix

1. The Operator navigation item text appears in the same color as all other navigation items
2. When active, the Operator item displays the same blue left border indicator as other items
3. Hover and focus states are identical to other navigation items
4. No visual distinction between Operator and other sidebar navigation topics

## Testing Criteria

1. [ ] Operator navigation item text color matches other navigation items
2. [ ] Operator active state styling matches other navigation items
3. [ ] Operator hover state styling matches other navigation items
4. [ ] No regression in other navigation item styling
5. [ ] Sidebar collapsed view shows consistent styling
6. [ ] Visual inspection confirms no color differentiation

## Implementation Notes

- The `data-module` attribute on nav items may still be useful for other purposes (e.g., testing, analytics) and does not need to be removed
- Verify the `--color-operator` variable is not used elsewhere before removing it
- Consider searching for any JavaScript that may rely on the operator-specific styling

## References

- Navigation configuration: `services/gateway/src/frontend/command-hub/navigation-config.js`
- Sidebar rendering: `services/gateway/src/frontend/command-hub/app.js` (line 4014, `renderSidebar()`)
- Styles: `services/gateway/src/frontend/command-hub/styles.css`
