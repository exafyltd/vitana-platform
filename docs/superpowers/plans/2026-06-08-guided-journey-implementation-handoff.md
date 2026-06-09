# Guided Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Guided Journey onboarding mode to Maxina/Vitanaland while preserving the existing Full App design exactly.

**Architecture:** Implement this as an additive UX layer: a durable onboarding/mode state, a Guided Journey catalog inside My Journey, Vitana/ORB-guided explanation and practice flows, and an Admin Knowledge Base Checklist editor. Full App remains the existing app and design surface; Guided Mode routes users through the new learning layer without duplicating account, support, subscription, or sidebar navigation.

**Tech Stack:** Vitana platform backend/data layer, Vitana v1 frontend, existing Vitana v1 design system/components, existing ORB/Vitana assistant bridge, existing Admin/Knowledge Base patterns, existing routing/auth/subscription infrastructure.

---

## Copy-Paste Handoff Prompt

Use this exact instruction block when handing the work to another developer or agent:

```text
You are implementing the Maxina/Vitanaland Guided Journey onboarding UX.

NON-NEGOTIABLE DESIGN RULE:
This is not a redesign. Do not change the existing Vitana v1 / Full App design. Do not change existing card sizes, font sizes, colors, spacing, button styling, shadows, radii, header styling, bottom navigation styling, sidebar styling, icons, or page composition in the Full App.

Full App must remain visually identical to the current production/Vitana v1 experience. Guided Journey is an additive UX layer. New Guided Journey components must reuse existing Vitana v1 design tokens, component primitives, typography, colors, spacing, button patterns, card patterns, header patterns, and navigation patterns. Do not copy prototype CSS into production as a new design language.

What we are adding:
- A user mode: Guided Journey vs Full App.
- A segmented switch: Guided Journey / Full App.
- Guided Journey hides sidebar/menu dots. No dots in Guided Mode.
- Full App keeps the existing full-app three-dot menu/sidebar access.
- My Journey remains the onboarding home in Guided Mode.
- The existing My Journey start view stays; add the 90-session / 250-topic catalog below it.
- Every session/topic click activates Vitana/ORB, Vitana explains, then redirects to the topic explanation or guided practice flow.
- Topic Explanation has only: short user benefit summary, Replay, Start Practice, Back to Journey.
- Practice redirects to the real feature screen or controlled guided practice target.
- Account, subscription, privacy, settings, support, logout, and sidebar navigation are not duplicated in Guided Mode. Users switch to Full App and use the existing Full App account/settings/navigation surfaces.
- Admin Pages -> Knowledge Base gets a Checklist tab so the 90-session / 250-topic curriculum is editable, validated, published, rolled back, and consumed by My Journey.

What we are not doing:
- No Full App redesign.
- No separate Guided Mode account/support overlay.
- No new sidebar in Guided Mode.
- No new design system.
- No marketing/landing page.
- No calendar-day onboarding logic. Sessions are usage sessions, not real-world days.
- No lesson completion from listening only. Completion requires a tiny guided-practice action.

Reference docs:
- docs/superpowers/specs/2026-06-04-my-journey-usage-catalog-design.md
- docs/superpowers/specs/2026-06-04-maxina-90-day-journey-curriculum-v2.md
- docs/superpowers/plans/2026-06-08-guided-journey-implementation-handoff.md
```

## Implementation Boundaries

The current workspace contains the prototype and planning docs, not the real Vitana platform and Vitana v1 repositories. Before writing production code, the implementer must locate both repositories and create a local path map.

Required repository roles:

- **Vitana platform:** durable onboarding/mode state, checklist persistence, Admin Knowledge Base Checklist APIs, publish/rollback/audit, subscription and entitlement checks.
- **Vitana v1:** My Journey UI integration, Guided Journey catalog rendering, segmented switch, route guards, ORB/Vitana interaction bridge, guided practice UI, Full App navigation behavior.

Required state boundaries:

- `mode`: UX mode, either `guided` or `full`.
- `journey_progress`: learning/practice progress.
- `feature_permission`: product access/release rules.
- `subscription`: commercial entitlement.

Do not combine these into one flag.

## Task 1: Repository And Design Freeze Audit

**Files:**
- Read: Vitana platform repository root.
- Read: Vitana v1 repository root.
- Read: existing Vitana v1 My Journey screen/component files.
- Read: existing Vitana v1 design system/theme/tokens/components.
- Create: a path map in the implementation PR description listing the exact production files found for each responsibility below.

- [ ] **Step 1: Locate production files**

Find the real files for:

- My Journey / Autopilot screen.
- Full App header and three-dot/sidebar navigation.
- Bottom navigation.
- ORB/Vitana assistant trigger.
- Existing buttons, segmented controls/tabs, cards, typography, colors, spacing tokens.
- Admin Pages / Knowledge Base.
- User profile/onboarding state.
- Subscription/entitlement state.

- [ ] **Step 2: Record design-freeze baseline**

Before changes, capture screenshots or visual snapshots of:

- Full App My Journey start view.
- Full App header with three-dot menu.
- Full App bottom navigation.
- Existing account/settings/subscription entry.

Expected result: these screenshots become the visual baseline. Later changes must not alter them.

- [ ] **Step 3: Add a design guardrail note to the implementation PR**

The PR description must include:

```text
Design guardrail: Full App design is frozen. This PR adds Guided Journey UX and state only. Existing Full App cards, colors, typography, spacing, header, bottom navigation, sidebar/menu, and account/settings surfaces are not redesigned.
```

## Task 2: Durable Guided/Full Mode State

**Files:**
- Modify: platform user/profile/onboarding state model.
- Modify: platform API or data access layer for user onboarding state.
- Modify: v1 app bootstrap/user context to read mode state.
- Test: platform state tests and v1 route/bootstrap tests.

- [ ] **Step 1: Add mode state**

Add or extend user onboarding state with:

```ts
type JourneyMode = "guided" | "full";

type JourneyState = {
  mode: JourneyMode;
  currentSession: number;
  completedTopicIds: string[];
  completedPracticeCount: number;
  qualifiedAt: string | null;
  skippedOnboardingAt: string | null;
  enteredFullModeAt: string | null;
  returnedToGuidedAt: string | null;
};
```

- [ ] **Step 2: Persist mode changes**

Implement:

```ts
setJourneyMode(userId: string, mode: "guided" | "full"): Promise<JourneyState>
```

Rules:

- Switching to `full` sets `enteredFullModeAt` when first entered.
- Switching to `full` before qualification sets `skippedOnboardingAt` when first skipped.
- Switching to `guided` sets `returnedToGuidedAt`.
- Switching modes never deletes progress.

- [ ] **Step 3: Test state separation**

Test:

- Changing `mode` does not alter subscription.
- Changing `mode` does not alter entitlement/feature permission.
- Changing `mode` does not clear completed topics.
- Switching back to `guided` resumes same current session.

## Task 3: Admin Knowledge Base Checklist

**Files:**
- Modify: platform Admin Pages / Knowledge Base.
- Create or modify: Checklist data model/table/API.
- Modify: v1/admin frontend tab if Admin UI is in v1.
- Test: Admin checklist validation and publish tests.

- [ ] **Step 1: Add Checklist tab**

Add `Admin Pages -> Knowledge Base -> Checklist`.

Checklist fields:

```ts
type ChecklistTopic = {
  id: string;
  session: number;
  position: number;
  label: string;
  shortDescription: string;
  vitanaVoiceScript: string;
  topicExplanationSummary: {
    whatItIs: string;
    userBenefit: string;
    whenToUse: string;
    tryThis: string;
  };
  guidedPracticeTarget: string;
  completionEvent: string;
  unlockRule: string;
  sourceRefs: string[];
  status: "draft" | "published" | "disabled";
};
```

- [ ] **Step 2: Add validation**

Publish validation must fail unless:

- 90 sessions exist.
- 250 topics exist.
- Sessions 1-20 have 2 topics each.
- Sessions 21-90 have 3 topics each.
- Labels are 1-4 words.
- Every topic has a Vitana voice script.
- Every topic has a guided practice target.
- Business/longevity-economy topics are correctly gated.

- [ ] **Step 3: Add publish/rollback**

Admins can:

- Save draft.
- Preview in My Journey.
- Publish.
- Roll back.
- Export.

My Journey consumes only the published checklist version.

## Task 4: Guided Mode Route Shell

**Files:**
- Modify: v1 route guard / app shell / My Journey route.
- Modify: v1 header rendering where My Journey is mounted.
- Test: Guided/Full route tests and visual checks.

- [ ] **Step 1: Default first-time users to Guided Mode**

After registration/name form, route first-time users to My Journey in Guided Mode.

- [ ] **Step 2: Hide sidebar/menu dots in Guided Mode**

In Guided Mode:

- No top-left dots.
- No sidebar/mobile drawer entry.
- No account/support overlay.

In Full App:

- Keep the existing three-dot/sidebar behavior exactly as production currently has it.

- [ ] **Step 3: Route account/settings/support through Full App**

If the user requests account, subscription, privacy, settings, support, logout, or sidebar navigation while in Guided Mode:

1. Switch `mode` to `full`.
2. Open the existing Full App account/settings/navigation surface.
3. Do not show a Guided Mode overlay.

## Task 5: My Journey Guided Catalog

**Files:**
- Modify: existing v1 My Journey screen.
- Add: Guided Journey catalog component near My Journey route.
- Reuse: existing v1 cards/buttons/tabs/typography/tokens.
- Test: catalog render tests and interaction tests.

- [ ] **Step 1: Preserve existing My Journey first viewport**

Do not rebuild the Full App My Journey screen. In Guided Mode, preserve the current start view structure and add onboarding-specific elements without changing production Full App layout.

Guided Mode first viewport:

- MAXINA header and voice button.
- No menu dots.
- My Journey title.
- Existing shortcut row.
- Existing Journey counter/goal card structure, using approved existing tokens.
- `Start Journey` before first start.
- `Start Session N` after started.
- Segmented `Guided Journey / Full App` switch below the Journey card.

- [ ] **Step 2: Add catalog below first viewport**

Below the Journey card and segmented switch, render:

- Chapter filters.
- Scrollable 90-session catalog.
- 250 topic cards from published checklist.
- Session rows can be clicked.
- Topic cards can be clicked.

- [ ] **Step 3: Keep text minimal**

Do not add dashboard counters like:

- topic cards complete.
- usage sessions total.
- ready to practice.
- preview locked.

Do not add `Start Practice` on the My Journey start view. Practice starts from Topic Explanation.

## Task 6: Segmented Guided Journey / Full App Switch

**Files:**
- Modify: v1 My Journey screen or mode switch component.
- Reuse: existing segmented control/tab/button pattern if available.
- Test: mode switch interaction tests.

- [ ] **Step 1: Add switch**

Labels:

- `Guided Journey`
- `Full App`

Guided Mode:

- `Guided Journey` active.
- `Full App` inactive.

Full App:

- `Full App` active.
- `Guided Journey` inactive.

- [ ] **Step 2: Persist switch**

Clicking `Full App`:

- Updates `mode` to `full`.
- Opens Full App My Journey.
- Does not clear journey progress.

Clicking `Guided Journey`:

- Updates `mode` to `guided`.
- Opens Guided My Journey.
- Restores the same current session/progress.

## Task 7: Vitana/ORB Explanation Flow

**Files:**
- Modify: existing ORB/Vitana assistant bridge.
- Modify: My Journey catalog interactions.
- Add: topic explanation route/surface if none exists.
- Test: ORB command tests and UI flow tests.

- [ ] **Step 1: Start Journey flow**

Click `Start Journey`:

1. Opens ORB/Vitana voice state.
2. Vitana explains the 90-session journey.
3. App marks journey started.
4. Button becomes `Start Session 1`.
5. Vitana redirects to Session 1 / Topic 1 explanation.

- [ ] **Step 2: Session/topic click flow**

Clicking any session or topic:

1. Activates Vitana/ORB.
2. Vitana explains the session/topic.
3. Vitana redirects to Topic Explanation.

Topic Explanation includes:

- Topic title.
- One short summary section with: what it is, user benefit, when to use, try this.
- Buttons: `Replay`, `Start Practice`, `Back to Journey`.

Do not show internal admin fields such as source, safety policy, script source, or checklist metadata to the end user.

## Task 8: Guided Practice And Completion

**Files:**
- Modify: guided practice routing.
- Modify: existing feature screens only by adding guided entry points where necessary.
- Test: practice completion tests.

- [ ] **Step 1: Redirect to real feature targets**

`Start Practice` routes to the real feature or controlled guided surface for:

- Life Compass.
- Vitana Index.
- Reminder.
- Calendar.
- Find a Match.
- Post Activity.
- Create Event.
- Attend/search events.
- Live Room.
- Media Hub.
- Memory.
- Autopilot.
- Universal Cart.
- Business post / business match / client finding.

- [ ] **Step 2: Complete only after tiny action**

Listening is not completion.

Completion requires one small guided-practice event, such as:

- choosing one Life Compass goal.
- viewing one Vitana Index signal.
- creating one reminder draft.
- opening one match explanation.
- drafting one activity post.
- previewing one event creation step.

After completion:

- Add topic ID to completed topics.
- Increment completed practice count.
- Return to My Journey or continue to next topic based on existing UX pattern.

## Task 9: Full App Visual Regression Gate

**Files:**
- Add or update visual/e2e tests in the real v1 repository.
- Include baseline screenshots from Task 1.

- [ ] **Step 1: Verify Full App unchanged**

Compare before/after screenshots for:

- Full App My Journey.
- Full App header.
- Full App three-dot menu/sidebar.
- Full App bottom navigation.
- Existing account/settings/subscription surfaces.

Acceptance:

- No intentional visual changes in Full App.
- Any visual diff must be explained as data/content only, not design.

- [ ] **Step 2: Verify Guided Mode additions**

Test:

- Guided Mode has no menu dots.
- Full App has existing three-dot menu.
- Guided/Full switch changes mode both ways.
- Account/settings/support request in Guided Mode switches to Full App.
- Topic click starts Vitana and opens Topic Explanation.
- Start Practice completes only after practice event.

## Task 10: Final Acceptance Checklist

The implementation is not complete until all are true:

- [ ] Full App design is unchanged.
- [ ] Guided Mode is additive and uses existing design patterns.
- [ ] No Guided Mode account/support overlay exists.
- [ ] Guided Mode has no dots/sidebar entry.
- [ ] Full App keeps existing three-dot menu/sidebar.
- [ ] My Journey remains the onboarding home.
- [ ] 90-session / 250-topic catalog is admin-editable.
- [ ] Vitana/ORB explains before redirecting.
- [ ] Topic Explanation has Replay, Start Practice, Back to Journey.
- [ ] Completion requires guided practice.
- [ ] Subscription and entitlement logic are separate from Journey mode.
- [ ] Visual regression evidence is attached to the PR.

## Source References

- Prototype: `my-journey-screens/prototype/index.html`
- Design spec: `docs/superpowers/specs/2026-06-04-my-journey-usage-catalog-design.md`
- Curriculum: `docs/superpowers/specs/2026-06-04-maxina-90-day-journey-curriculum-v2.md`
