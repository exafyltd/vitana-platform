# Universal Screen Pattern Documentation
**Version**: 1.0  
**Status**: CTO Approved  
**Last Updated**: 2025-01-27  
**Applies To**: ALL VITANA Application Screens

## Overview
This document defines the **MANDATORY** universal screen pattern that must be implemented across all screens in the VITANA application. This pattern has been validated across 22 screens (Home-5, Community-8, Health-5, Wallet-4) and ensures perfect visual consistency and maintainability.

## Pattern Categories

### 🏠 Home Screens (5 screens)
- Dashboard, AI Feed, Actions, Context, Matches

### 👥 Community Screens (8 screens) 
- Feed, Groups, Events, Meetups, Live Rooms, Live Interaction, Challenges, Sharing

### 🏥 Health Screens (5 screens)
- Overview, Health Tracker, Biomarker Results, Conditions & Risks, Wellness Services

### 💰 Wallet Screens (4 screens)
- Balance, Rewards, Subscriptions, Overview

---

## 1. MANDATORY IMPORTS PATTERN

```typescript
import SEO from "@/components/SEO";
import AppLayout from "@/components/AppLayout";
import SubNavigation from "@/components/SubNavigation";
import StandardHeader from "@/components/StandardHeader";
import { UtilityActionButton } from "@/components/ui/utility-action-button";
import { ExpandableSearchButton } from "@/components/ui/expandable-search-button";
import { SplitBar, SplitBarContent, SplitBarList, SplitBarTrigger } from "@/components/ui/split-bar";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useState } from "react";
import { [SECTION]Navigation } from "@/config/navigation";
import { SCREEN_IDS, withScreenId } from "@/lib/screen-id";
```

**Section Navigation Mapping:**
- `homeNavigation` for Home screens
- `communityNavigation` for Community screens  
- `healthNavigation` for Health screens
- `walletNavigation` for Wallet screens

---

## 2. EXACT COMPONENT STRUCTURE

```typescript
export default withScreenId(function [ScreenName]() {
  const [activeTab, setActiveTab] = useState("[default-tab]");
  const [actionPopupOpen, setActionPopupOpen] = useState(false);

  return (
    <AppLayout>
      <SEO 
        title="[Page] | [Section]" 
        description="[Page description]" 
        canonical={window.location.href} 
      />
      <SubNavigation items={[section]Navigation} />
      
      <div className="p-6 bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 min-h-screen">
        <div className="max-w-7xl mx-auto">
          
          <StandardHeader 
            title="[Page title with emoji at end] ✨"
            description="[Page description]"
          />
          
          <UtilityActionButton>
            <ExpandableSearchButton 
              placeholder="Search [section]..." 
              onSearch={(query) => console.log(query)}
            />
            <Button 
              size="sm" 
              onClick={() => setActionPopupOpen(true)}
            >
              <Plus className="w-4 h-4 mr-2" />
              [Section] Actions
            </Button>
          </UtilityActionButton>
          
          <SplitBar value={activeTab} onValueChange={setActiveTab}>
            <SplitBarList>
              <SplitBarTrigger value="[tab1]">[Tab1 Label]</SplitBarTrigger>
              <SplitBarTrigger value="[tab2]">[Tab2 Label]</SplitBarTrigger>
            </SplitBarList>
            
            <SplitBarContent value="[tab1]">
              <div className="grid grid-cols-12 gap-6 mt-6">
                {/* Content Grid - See Grid Patterns Below */}
              </div>
            </SplitBarContent>
            
            <SplitBarContent value="[tab2]">
              <div className="grid grid-cols-12 gap-6 mt-6">
                {/* Content Grid - See Grid Patterns Below */}
              </div>
            </SplitBarContent>
          </SplitBar>
          
        </div>
      </div>
      
      {/* Action Popup Component */}
      {actionPopupOpen && (
        <[Section]ActionPopup
          open={actionPopupOpen}
          onClose={() => setActionPopupOpen(false)}
        />
      )}
    </AppLayout>
  );
}, SCREEN_IDS.[SCREEN_CONSTANT]);
```

---

## 3. CRITICAL CONTAINER PATTERNS

### Outer Container (NEVER CHANGE)
```typescript
<div className="p-6 bg-gradient-to-br from-purple-50 via-blue-50 to-pink-50 min-h-screen">
```

### Inner Container (NEVER CHANGE) 
```typescript
<div className="max-w-7xl mx-auto">
```

### Content Grid Container (MANDATORY)
```typescript
<div className="grid grid-cols-12 gap-6 mt-6">
```

---

## 4. ACTION BUTTON STANDARDS

### Required Pattern
```typescript
<Button size="sm" onClick={() => setActionPopupOpen(true)}>
  <Plus className="w-4 h-4 mr-2" />
  [Section] Actions
</Button>
```

### Text Templates by Section
- **Home**: "Home Actions"  
- **Community**: "Community Actions"
- **Health**: "Health Actions"
- **Wallet**: "Wallet Actions"
- **Sharing**: "Sharing Actions"
- **Memory**: "Memory Actions"
- **Calendar**: "Calendar Actions"

### NEVER USE
❌ Custom icons (always `Plus`)  
❌ Default button size (always `size="sm"`)  
❌ Custom action text patterns

---

## 5. 12-COLUMN GRID LAYOUTS

### Pattern 1: Big + Small + Small (6+3+3)
```typescript
<div className="grid grid-cols-12 gap-6 mt-6">
  <div className="col-span-12 lg:col-span-6">
    {/* Big Card */}
  </div>
  <div className="col-span-12 lg:col-span-3">
    {/* Small Card */}
  </div>
  <div className="col-span-12 lg:col-span-3">
    {/* Small Card */}
  </div>
</div>
```

### Pattern 2: Small + Small + Big (3+3+6)
```typescript
<div className="grid grid-cols-12 gap-6 mt-6">
  <div className="col-span-12 lg:col-span-3">
    {/* Small Card */}
  </div>
  <div className="col-span-12 lg:col-span-3">
    {/* Small Card */}
  </div>
  <div className="col-span-12 lg:col-span-6">
    {/* Big Card */}
  </div>
</div>
```

### Pattern 3: Full Width (12)
```typescript
<div className="grid grid-cols-12 gap-6 mt-6">
  <div className="col-span-12">
    {/* Full Width Card */}
  </div>
</div>
```

### Pattern 4: Four Equal Columns (3+3+3+3)
```typescript
<div className="grid grid-cols-12 gap-6 mt-6">
  <div className="col-span-12 md:col-span-6 lg:col-span-3">
    {/* Card */}
  </div>
  <div className="col-span-12 md:col-span-6 lg:col-span-3">
    {/* Card */}
  </div>
  <div className="col-span-12 md:col-span-6 lg:col-span-3">
    {/* Card */}
  </div>
  <div className="col-span-12 md:col-span-6 lg:col-span-3">
    {/* Card */}
  </div>
</div>
```

---

## 6. STANDARD HEADER PATTERN

### Three-Card Layout (MANDATORY)
```typescript
<StandardHeader 
  title="[Page Title with emoji] ✨"
  description="[Engaging page description that explains the page purpose]"
/>
```

### Title Format Rules
- **Format**: "[Descriptive Title] [Emoji]"
- **Examples**: 
  - "Track your wellness journey ✨"
  - "Connect with your community ✨"  
  - "Manage your health data ✨"
- **Emoji Position**: Always at the end
- **Tone**: Engaging and motivational

---

## 7. SPLIT BAR NAVIGATION

### Standard Pattern
```typescript
<SplitBar value={activeTab} onValueChange={setActiveTab}>
  <SplitBarList>
    <SplitBarTrigger value="[value1]">[Display Label 1]</SplitBarTrigger>
    <SplitBarTrigger value="[value2]">[Display Label 2]</SplitBarTrigger>
    {/* Maximum 3-4 tabs for optimal UX */}
  </SplitBarList>
  
  <SplitBarContent value="[value1]">
    {/* Grid content following 12-column pattern */}
  </SplitBarContent>
  
  <SplitBarContent value="[value2]">
    {/* Grid content following 12-column pattern */}
  </SplitBarContent>
</SplitBar>
```

### Tab Guidelines
- **Maximum**: 3-4 tabs for optimal UX
- **Labels**: Short, descriptive, action-oriented
- **Default**: Always set first tab as default
- **Content**: Each tab must have grid layout

---

## 8. MOTIVATIONAL BANNER INTEGRATION

### Section-Specific Banners
```typescript
// Insert between content rows for engagement
<MotivationalBanner variant="default" />           // Home screens
<CommunityMotivationalBanner variant="community" />  // Community screens  
<HealthMotivationalBanner variant="health" />       // Health screens
<WalletMotivationalBanner variant="wallet" />       // Wallet screens
```

### Placement Rules
- Between major content sections
- After every 2-3 card rows
- Before high-priority actions

---

## 9. MANDATORY COMPONENTS CHECKLIST

### ✅ Required Components (All 10)
1. **SEO** - Title, description, canonical URL
2. **AppLayout** - Main application wrapper
3. **SubNavigation** - Section navigation tabs  
4. **StandardHeader** - Three-card header layout
5. **UtilityActionButton** - Search + action container
6. **SplitBar** - Tab navigation system
7. **withScreenId** - Analytics tracking HOC
8. **Background gradient** - Purple-blue-pink gradient
9. **Plus icon** - In all action buttons
10. **size="sm"** - On all action buttons

### ❌ Forbidden Patterns
- Custom icons in action buttons
- Default button sizes
- Different container patterns
- Missing background gradients  
- Custom action button text
- Direct content without max-width wrapper
- Missing min-h-screen on outer container
- Skipping any mandatory components

---

## 10. VALIDATION CHECKLIST

### Pre-Implementation Checklist
- [ ] All 10 mandatory components present
- [ ] Container uses exact gradient pattern  
- [ ] Inner container uses `max-w-7xl mx-auto`
- [ ] Action button uses `Plus` icon and `size="sm"`
- [ ] Button text follows "[Section] Actions" pattern
- [ ] Grid follows 12-column responsive system
- [ ] StandardHeader has emoji at end of title
- [ ] All imports in correct order
- [ ] withScreenId HOC applied correctly  
- [ ] SEO title follows "[Page] | [Section]" format

### Post-Implementation Testing
- [ ] Responsive design works on mobile/tablet/desktop
- [ ] All tabs function correctly
- [ ] Action buttons open appropriate popups
- [ ] Search functionality works
- [ ] Navigation highlighting works
- [ ] Analytics tracking fires correctly

---

## 11. IMPLEMENTATION EXAMPLES

### ✅ CORRECT Implementations
Reference these validated screens:
- `src/pages/Home.tsx` (Home Dashboard)
- `src/pages/Community.tsx` (Community Overview)  
- `src/pages/Health.tsx` (Health Overview)
- `src/pages/Wallet.tsx` (Wallet Overview)
- `src/pages/Sharing.tsx` (Sharing Overview)

### ❌ INCORRECT Examples
Avoid these patterns:
- Single-card headers
- Missing action buttons
- Custom container classes
- Different gradient patterns
- Non-standard navigation

---

## 12. SCREEN ID CONSTANTS

### Required Pattern
```typescript
// In SCREEN_IDS constant
[SECTION]_[PAGE]: '[section]-[page]'

// Examples:
HOME_DASHBOARD: 'home-dashboard',
COMMUNITY_FEED: 'community-feed',
HEALTH_TRACKER: 'health-tracker',
WALLET_BALANCE: 'wallet-balance'
```

---

## 13. FUTURE DEVELOPMENT GUIDELINES

### When Creating New Screens
1. Copy the universal pattern template
2. Replace all `[SECTION]` and `[PAGE]` placeholders
3. Add appropriate navigation to `src/config/navigation.ts`
4. Create screen ID constant in `src/lib/screen-id.ts`
5. Validate against the 10-point checklist
6. Test responsive behavior

### When Updating Existing Screens
1. Check if screen follows universal pattern
2. If not, refactor to match pattern exactly
3. Preserve existing functionality
4. Update only UI structure, not business logic
5. Validate against checklist

### Breaking Changes
Any deviation from this pattern is considered a **BREAKING CHANGE** and requires:
- Design system team approval
- Documentation updates
- Pattern validation across all screens
- CTO sign-off

---

## 14. ENFORCEMENT

This pattern is enforced through:
- **Code Reviews**: All PRs must validate against checklist
- **TypeScript Interfaces**: Type safety for pattern compliance  
- **Automated Testing**: Pattern validation in CI/CD
- **Documentation**: This living document as source of truth

---

**REMEMBER**: This pattern has been validated across **ALL 22 screens** and ensures perfect visual consistency and maintainability across the entire VITANA application. 

**NO EXCEPTIONS** without explicit CTO approval.