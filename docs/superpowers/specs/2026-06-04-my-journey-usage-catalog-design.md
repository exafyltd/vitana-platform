# My Journey Usage Catalog Design

**Date:** 2026-06-04

**Goal:** Reduce first-time Maxina onboarding to one simple home: a scrollable, searchable My Journey catalog where Vitana teaches the application by voice, lesson by lesson, and releases feature access only after a tiny guided practice action.

**Decision:** My Journey becomes the single onboarding home for first-time users. The full app still exists, but first-time users are routed through the catalog until each feature has been explained, practiced, and released.

---

## Non-Negotiable Design Guardrail

This is a UX/routing/state addition, not a redesign.

The existing Vitana v1 / Maxina full app design must remain unchanged. Developers must not change full app card sizes, font sizes, colors, spacing, button styles, navigation styling, header styling, bottom navigation styling, icons, shadows, radii, or page composition. The full app view after switching to `Full App` must render the existing production My Journey/full app surfaces.

Guided Mode may add new onboarding-specific components:

- Guided Journey / Full App segmented switch.
- 90-session / 250-topic checklist below the current My Journey start view.
- Vitana voice/ORB teaching overlay and topic explanation flow.
- Guided-practice surfaces and release gates.
- Admin Knowledge Base -> Checklist editor.

These new Guided Mode components must reuse existing Vitana v1 design tokens, typography, colors, buttons, card patterns, layout spacing, icons, and component primitives wherever they already exist. Do not introduce a new design language for onboarding. Prototype CSS is only a product/UX reference; developers must map the behavior into the existing design system instead of copying prototype styling into production.

Full App mode is a design freeze. Guided Mode is an additive UX layer.

## Problem

The current onboarding model exposes too much at once:

- A large desktop sidebar and mobile drawer expose many categories immediately.
- My Journey shows many actions and waves, but the user is still asked to understand the whole app too early.
- The current post-registration flow explains Vitana, Autopilot, Calendar, and the 90-session journey in a long speech, then redirects users into the app.
- Voice is the main interface, but most users are not yet trained to use voice confidently.

The result is cognitive overload. Users need a simple cover surface that hides complexity while still allowing exploration.

## Core Model

The journey is session-based, not calendar-based.

`Session 3` means learning session 3, not the third real-world day after registration. A user may complete one session per day or ten sessions in one calendar day, pause for a week, then return to the exact next incomplete session. Progress advances only through session completion.

Each session follows this progression:

1. **Activate ORB:** user starts a session or presses the ORB.
2. **Explain:** Vitana explains the session or topic by voice.
3. **Redirect:** Vitana opens the correct screen for the user.
4. **Practice:** user completes one tiny guided action in a controlled onboarding surface.
5. **Release:** feature access is unlocked or marked as available for real use.
6. **Resume:** user returns to My Journey with the session marked complete.

A session is complete only after the guided-practice action is done. Listening alone is not enough.

## Catalog Structure

The catalog should cover 90 sessions, grouped into 6 chapters of 15 sessions:

1. **Basics:** Vitana, voice, account, profile, safety, navigation principles.
2. **Daily Use:** check-ins, diary, reminders, calendar, routines, simple actions.
3. **Community:** people, groups, events, live rooms, messaging, sharing boundaries.
4. **Health:** Vitana Index, goals, reports, biomarker concepts, health consent.
5. **Intelligence:** memory, patterns, Autopilot, recommendations, personalization.
6. **Discovery:** marketplace, services, professionals, products, sharing, long-term usage.

The first implementation can ship the catalog framework with a smaller authored session set, but the data model and UI must support the full 90-session curriculum.

The catalog content must belong to the Knowledge Base, not to frontend code alone. Add `Admin Pages -> Knowledge Base -> Checklist` as the editable source of truth for the onboarding checklist. My Journey should consume the published checklist version, while admins can draft, edit, validate, preview, publish, and roll back checklist changes.

## First-Time User Flow

After registration and the name/handle form, the user lands on `/autopilot` / My Journey, not Home or Community.

The first screen must preserve the current My Journey start view. The onboarding catalog should extend this screen, not replace it.

The start view contains:

- app header with MAXINA and voice state; no menu dots in Guided Mode
- title `My Journey`
- shortcut row: Search, Calendar, Life Compass
- the existing large gradient Journey counter/goal card
- circular session counter inside the card
- goal card such as `Improve quality of life and extend lifespan`
- Guided Mode uses the bright Maxina-header blue background on the Journey card as the visual mode signal
- one clear next button
- one segmented switch directly below the Journey card with `Guided Journey` and `Full App`
- the ORB and bottom navigation with `My Journey`, `Inbox`, ORB, `Live`, and `Events`

First-run button states:

- before the user starts: `Start Journey`
- after Vitana gives the journey introduction: `Start Session 1`
- after progress begins: `Start Session N`

`Start Journey` is not a reading screen. It opens the ORB overlay and Vitana gives the introductory speech: what the 90 sessions are, how learning works, how Vitana talks, how Vitana redirects, and why the user should press the ORB whenever they need help.

The ORB is not decorative. Pressing the ORB starts Vitana, and Vitana can answer, teach, navigate, or execute after confirmation. Onboarding should train this behavior from the first sessions.

Guided Mode does not expose the sidebar/menu dots. During onboarding, user account, subscription, payments, privacy, settings, support, logout, and sidebar navigation remain reachable by switching to the Full App and opening the existing account/settings or navigation surfaces there. Do not build a separate Guided Mode overlay or duplicate account/support screen.

The start view must not show secondary analytics cards such as `topic cards complete`, `usage-sessions total`, `ready to practice`, or `preview locked`. These make the first viewport feel like a dashboard. Keep them out of the user-facing start view.

The start view must not show `Start Practice`. The user first starts the current session or topic through Vitana; the Topic Explanation screen contains `Replay`, `Start Practice`, and `Back to Journey`.

When the user taps `Start Session 5`, the ORB overlay opens and Vitana starts talking. Vitana explains what Session 5 is, then redirects the user to the correct Session 5 screen. The user should feel from the beginning that answers, learning, navigation, and execution happen through ORB communication.

The first five sessions must anchor the basic mental model:

- Session 1: What is Vitanaland and the Maxina Community?
- Session 2: Vitana Assistant and ORB voice.
- Session 3: My Journey, 90 sessions, jumping freely, and practice qualification.
- Session 4: Life Compass.
- Session 5: Vitana Index and how to improve it.

The start view must not show a separate text box such as `Ask Vitana what to do today`. During every session explanation, Vitana should teach the habit: "Whenever you have a question, tap the ORB and ask me."

After Vitana redirects to a session, topic explanation, practice screen, or locked preview, the screen should include one small helper cue directly above the bottom ORB: `Need help? Press the ORB and ask Vitana.` The cue should be short, centered, and visually point down toward the ORB. Do not place it under the content buttons as normal scroll content, and do not add it as another large card on the My Journey start view.

The top-right orientation element on redirected learning screens must not show local decorative facts such as `2 topics`, `voice`, or `1 action`. Those facts add no value. Either remove the element or use it for global journey orientation. The chosen pattern is a compact `Session N/90` journey-position badge with the chapter label, so users who jump from Session 5 to Session 77 still know where the selected topic belongs.

Practice completion should generate a separate Journey/Practice progress signal first. Recommended qualification rule: users can browse and preview any of the 90 sessions freely, but first-stage qualification requires 60 completed guided-practice actions. This is enough to reward real use without making the journey feel like school homework. Do not automatically inflate the Vitana Index with lesson completion until the index model explicitly defines how learning progress contributes to health, community, or quality-of-life scoring.

## Guided Mode And Full Mode

Build the journey as two app modes, not as two separate products.

### Guided Mode

Guided Mode is the default state for new users.

- My Journey is the home screen.
- Vitana explains first, then redirects to Topic Explanation.
- Topic Explanation contains the short user-facing summary and the three actions: `Replay`, `Start Practice`, `Back to Journey`.
- Complex product areas can be visible, but unreleased or unpracticed areas route through Vitana explanation gates.
- Account, subscription, payments, privacy, settings, support, and logout remain available through the existing Full App account/settings area.

### Full Mode

Full Mode is the normal Maxina app experience.

- Full navigation and existing feature surfaces are available.
- My Journey remains available as an optional learning/progress screen.
- Vitana remains the voice-first help, navigation, and execution layer.
- Subscription and permission rules still apply. Full Mode means full interface scope, not free access to paid features.

### Switching Rules

Users can switch both ways.

- Guided Mode shows a two-option segmented switch directly below the Journey card: `Guided Journey` active, `Full App` inactive.
- Full Mode shows the same segmented switch directly below the Journey card: `Full App` active, `Guided Journey` inactive.
- Do not render a separate explanatory mode/status card. The switch is only a compact view selector.
- Switching to Full Mode does not delete topic progress, practice progress, last session, voice history, or qualification state.
- Returning to Guided Mode resumes the same My Journey progress.
- If a user skipped early, keep `skipped_onboarding_at` and continue to show My Journey as available, not as a forced gate.

### Qualification

Qualification is separate from skipping.

- `qualified`: user completed the required practice count.
- `skipped`: user chose Full Mode before qualifying.
- `guided`: user is still in the guided path.
- `full`: user is currently using the full interface.

Recommended first-stage qualification remains 60 completed guided-practice actions.

Below the start view, the same scroll continues into:

- current incomplete session
- chapter tabs or filters
- scrollable session/topic list
- visible locked future items that can be explained but not opened for full use

The user can scroll freely to Session 1, Session 12, Session 55, or Session 90. Future sessions are not hidden. Clicking them starts a preview explanation, where Vitana can say that real usage is released later.

After onboarding is finished, the start view stays. The catalog section converts from onboarding mode into Growth Mode, but the user should not feel that the My Journey home was replaced.

## Click Behavior

Clicking a **session**:

- Opens the ORB overlay first.
- Starts Vitana's overview explanation by voice.
- Lets Vitana redirect directly to the next unfinished topic's Topic Explanation screen.
- Avoids a separate Session Detail screen because the My Journey catalog already shows the session topics.

Clicking a **topic**:

- Opens the ORB overlay first.
- Vitana explains the selected topic by voice.
- Vitana redirects to the Topic Explanation screen for that topic.
- The Topic Explanation screen contains the Practice action.
- The user does not have to find the screen manually.

Clicking a **locked feature topic**:

- Does not navigate to the full feature.
- Starts a Vitana preview: "This is what the feature does. You will use it after completing Lesson X."
- Offers "Remind me when released" or "Continue journey."

Clicking a **released feature topic**:

- Allows normal navigation.
- Still offers "Explain before opening" for users who want guidance.

## Voice Assistant Role

Vitana is the speaking manual for the app.

Vitana must be able to:

- Explain the current session.
- Explain any topic in the catalog.
- Explain future locked features without opening them.
- Start guided practice.
- Confirm lesson completion.
- Tell the user what is available now and what is still learning-gated.

Every voice explanation needs a short text transcript or summary on screen for accessibility, noisy environments, and users who prefer reading.

## Guided Practice

Guided practice should be tiny and controlled. It should avoid dropping the user into a full complex screen before they are ready.

Practice means Vitana redirects the user to the real feature screen where the action belongs. Examples: Post Activity, Create Event, Find a Match, Create Reminder, Life Compass, Vitana Index, Universal Cart, Live Room, Media Hub, or Business Hub. Vitana explains what is happening before the redirect and guides one small action after the screen opens.

Examples:

- Voice session: user taps the orb and says one suggested phrase.
- Diary session: user answers one well-being question, then Vitana saves a sample entry.
- Community session: user previews a match card, then chooses "save for later" or "not now."
- Health session: user views a simplified Vitana Index explanation, then identifies one focus area.
- Calendar session: user confirms one suggested reminder in an onboarding card.

The practice action should be small enough to complete in 30-90 seconds.

## Navigation Gating

Existing navigation should remain structurally intact, but first-time users should be routed back through My Journey when trying to access unreleased areas.

For unreleased features:

- Desktop sidebar/mobile drawer item can remain visible, but route access shows a Vitana explanation/release gate.
- The gate says what the feature is, when it is released, and which lesson unlocks it.
- The user can return to My Journey or listen to a preview explanation.

Never gate account and support utilities. User Account, Subscription, Payments, Privacy, Settings, Support, and Logout must remain reachable during onboarding and after onboarding, but they route to the existing Full App account/settings surfaces instead of a Guided Mode overlay.

For released features:

- Navigation works normally.
- My Journey still remains the user's learning home until the onboarding curriculum is complete.

## State Requirements

The app needs durable per-user onboarding state:

- Current session.
- Completed session IDs.
- Completed topic IDs.
- Practice completion state.
- Current app mode: `guided` or `full`.
- Onboarding status: `not_started`, `in_progress`, `qualified`, `skipped`, or `completed`.
- Qualification count and threshold.
- `entered_full_mode_at`, `returned_to_guided_at`, and `skipped_onboarding_at` timestamps where applicable.
- Released feature IDs.
- Last opened session/topic.
- Voice explanation seen/heard state.
- Optional acceleration count: how many sessions completed in the current calendar day.

LocalStorage may be used only as a fast UI hint. Durable state must live in the backend/Supabase because users can change devices or return after a pause.

## Existing App Touchpoints

Likely frontend areas:

- `src/pages/onboarding/OnboardingWelcome.tsx`: redirect first-time users to My Journey after the name form.
- `src/pages/AutopilotDashboard.tsx`: replace or rework the current dense My Journey layout into the catalog home.
- `src/config/journeyWaves.ts`: evolve from wave timeline to usage-lesson chapters, or add a new catalog config beside it.
- `src/components/health/JourneyDayBadge.tsx`: replace the user-facing "Day N of 90" language with "Session N of 90", or rename the component when implementation scope allows.
- `src/components/health/JourneyWaveMap.tsx`: replace wave strip with chapter/catalog navigation.
- `src/components/AutopilotPopup.tsx`: keep as task executor; do not overload it as the lesson explainer unless it is explicitly refactored.
- Voice/ORB bridge: add a callable event or command for "explain lesson/topic" and "start guided practice."
- Admin Pages Knowledge Base: add a `Checklist` tab for editing the 90-session/250-topic catalog, including labels, Vitana explanations, transcripts, practice actions, unlock rules, knowledge sources, status, publish state, and audit history.

## Repository Integration Notes

This prototype workspace contains the mockup and planning docs only. Before developer execution, verify the exact paths in both repositories:

- Vitana platform repository: own durable onboarding/mode state, route guards, subscription checks, Admin Knowledge Base Checklist, and backend persistence.
- Vitana v1 repository: map existing My Journey, bottom navigation, ORB bridge, full app navigation, and legacy onboarding entry points to the shared mode model.

Integration must keep these boundaries:

- Mode state is product UX state.
- Subscription state is commercial entitlement state.
- Feature permission state is access-control state.
- Journey progress is learning/practice state.

Do not combine these into one flag. Developers should create or reuse a single user onboarding/mode model and expose it consistently to routing, My Journey, Vitana voice commands, and Admin checklist publishing.

## Changed Screen Set

Build 8 changed screens for the onboarding redesign.

### 01 My Journey Start And Catalog

Purpose: keep the current My Journey start view as the permanent home, then add the 250-topic onboarding catalog below it.

Visible content:

- App header with MAXINA and voice state; no sidebar/menu dots in Guided Mode
- title `My Journey`
- current shortcut row: Search, Calendar, Life Compass
- existing large gradient Journey card
- circular session counter that stays useful after onboarding
- goal card, deadline prompt, and motivational line
- compact learning counter: completed topics out of 250 during onboarding, then Growth Mode milestones after onboarding
- one clear hero button: `Start Journey` for first-run users, then `Start Session N`
- segmented Guided Journey / Full App switch
- chapter filters
- scrollable list of all 90 sessions
- each session row shows 2 topic cards for sessions 1-20 and 3 topic cards for sessions 21-90
- topic cards show short labels, topic IDs, state, and a tap target for Vitana explanation
- bottom navigation uses `My Journey`, `Inbox`, ORB, `Live`, and `Events`

Scroll behavior:

- top of screen stays close to today's My Journey start view
- first scroll reveals simple commands, chapter filters, and days 1-10 with orientation topics
- middle scroll shows health, memory, calendar, community, events, Live Rooms, and Media Hub
- lower scroll shows Discover, Wallet, Sharing, Business Hub, Sell and Earn, Marketplace Autopilot, safety, and Graduation

### 02 Topic Explanation

Purpose: make every checklist item clickable and teachable by Vitana.

Visible content:

- topic ID and display label
- global journey-position badge such as `5/90 BASICS`
- short `What you learn` summary
- `What it is`: one short sentence explaining the topic
- `Your benefit`: why the user should care
- `When to use`: when this topic helps
- `Try this`: the tiny practice action
- buttons: `Replay`, `Start Practice`, and `Back to Journey`
- the three buttons sit in one equal-width row, centered with equal gaps; multi-word labels may wrap to two lines so all buttons keep the same size

Do not show internal metadata such as source, checklist, manual source, voice script, safety level, or business gate in the community-user Topic Explanation screen. Those fields belong in Admin Topic Editor and publish validation.

### 03 Guided Practice

Purpose: complete a topic through a tiny action, not by passive listening.

Visible content:

- one small guided action
- Vitana coaching prompt
- safe preview state
- completion event
- `Complete`, `Skip for now`, and `Replay explanation`

### 04 Locked Preview Gate

Purpose: allow browsing ahead without dropping the user into complex features too early.

Visible content:

- feature name
- what the feature does
- release condition
- future session
- `Remind me`, `Preview explanation`, and `Continue Journey`

### 05 Admin Checklist List

Purpose: make the 250-topic checklist editable inside Admin Pages.

Visible content:

- Admin Pages navigation
- Knowledge Base tabs with `Checklist` selected
- table of all 250 topic cards
- search, filters, day/chapter selectors, status filters, business gate filter
- row actions for edit, disable, preview, and history
- publish status and current version

### 06 Admin Topic Editor

Purpose: edit one checklist topic without developer involvement.

Visible content:

- topic ID, day number, position, label, title, short description
- Vitana voice script
- silent transcript
- practice action definition
- completion event
- unlock rule
- manual/knowledge source
- safety level and business gate
- save draft and preview buttons

### 07 Admin Publish Validation

Purpose: prevent broken onboarding content from reaching users.

Visible content:

- validation summary
- 90 session check
- 250 topic-card check
- 2 cards/session for sessions 1-20
- 3 cards/session for sessions 21-90
- 1-4 word label check
- missing Vitana script check
- missing practice action check
- publish, rollback, and export actions

### 08 Full Mode Home

Purpose: show the state after the user qualifies or chooses to use the full app early.

Visible content:

- the original My Journey/full app dashboard design, not a redesigned Full Mode landing page
- original header with the full-app three-dot menu, shortcut row, Journey counter card, and goal card
- the full app Journey card keeps the original gradient/background; only Guided Mode turns the card bright blue
- the segmented switch below the Journey card with `Full App` active
- original-style feed cards below the Journey card, including people matches, upcoming events, Autopilot, and Vitana Index
- no new Full Mode feature-grid or separate mode/status card

Behavior:

- opens from tapping `Full App` in the segmented switch
- opens from the top-left account/menu utility route when a Guided Mode user needs account, subscription, privacy, settings, support, or logout
- does not reset My Journey progress
- keeps the ORB available
- allows the user to return to Guided Mode at any time by tapping `Guided Journey`

## Success Criteria

The redesign succeeds if:

- A first-time user sees one obvious place to begin.
- The user can understand that "Session" means learning progress, not calendar time.
- The user can click any lesson or topic and hear Vitana explain it.
- The user cannot accidentally fall into an unreleased complex screen.
- A lesson completes only after a tiny guided-practice action.
- A motivated user can complete multiple sessions in one real day.
- A returning user resumes exactly where they left off.
- Existing users are not forced into the first-time catalog gate unless their onboarding state is incomplete.
- Account, subscription, payments, privacy, settings, support, and logout remain accessible through the existing Full App account/settings area even when onboarding gates product features.
- Users can choose Full Mode early without destroying onboarding progress.
- Qualified users can enter Full Mode and later return to My Journey.
- Full Mode still respects subscription and feature-entitlement rules.

## Open Implementation Questions

These are implementation choices, not unresolved product direction:

- Whether the first seed of checklist content is imported from Markdown, CSV, or backend seed data. The product decision is already made: the editable source of truth is `Admin Pages -> Knowledge Base -> Checklist`.
- Whether route gating is centralized in `ProtectedRoute`/routing hooks or handled per feature route.
- Whether Vitana explanations use existing ORB commands immediately or first ship with a text/transcript fallback and voice event hook.
- Whether the first release contains all 90 lessons or a smaller chapter-one proof while preserving the full 90-lesson data shape.

## Self-Review

- Placeholder scan: no placeholder requirements remain.
- Scope check: this is one coherent onboarding redesign centered on My Journey.
- Ambiguity check: lesson progress is explicitly usage-based; completion requires guided practice; future features are explainable but gated.
- Constraint check: the design preserves existing navigation structure while adding first-time route gates, instead of requiring sidebar restructuring.
- Content ownership check: the checklist is editable Knowledge Base content in Admin Pages, not a permanently hardcoded frontend list.
