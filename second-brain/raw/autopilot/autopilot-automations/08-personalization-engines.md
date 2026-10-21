# AP-0800: Personalization Engines

> Automations that leverage the 25+ D-engines (D28–D51) for context-aware Autopilot actions.

---

## AP-0801 — Social Comfort-Aware Suggestions

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Before any social suggestion (AP-0100s, AP-0200s) |
| **Skill** | `vitana-personalization` (NEW) |

**What it does:**
Filters all social suggestions through the D35 Social Context Engine to respect user's comfort preferences.

**Actions:**
1. Get comfort profile: `GET /api/v1/social/comfort`
2. Check: group_size, involves_new_people, visibility, preferred_timing
3. Filter suggestions that violate boundaries: `POST /api/v1/social/check-boundary`
4. Only surface suggestions within comfort zone

**APIs used:**
- Full D35 Social Context API

---

## AP-0802 — Taste-Aligned Event Recommendations

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Event recommendation step (AP-0303, AP-0305) |
| **Skill** | `vitana-personalization` |

**What it does:**
Scores events through the D39 Taste & Lifestyle Alignment engine before recommending.

**Actions:**
1. Get taste bundle: `GET /api/v1/taste-alignment/bundle`
2. Score event: `POST /api/v1/taste-alignment/score`
3. Only recommend events with alignment > 60%
4. Record reactions for learning: `POST /api/v1/taste-alignment/reaction`

---

## AP-0803 — Opportunity Surfacing Automation

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Daily or on context change |
| **Skill** | `vitana-personalization` |

**What it does:**
Wraps D48 Opportunity Surfacing for Autopilot heartbeat execution.

**Actions:**
1. Call `POST /api/v1/opportunity-surfacing/surface`
2. Prioritize: Health > Social Belonging > Personal Growth > Exploration > Commerce
3. Surface via notification with ethical framing (no urgency, no scarcity)
4. Track engagement: `POST /api/v1/opportunity-surfacing/:id/engage`

---

## AP-0804 — Life-Stage Aware Communication

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Any Autopilot notification |
| **Skill** | `vitana-personalization` |

**What it does:**
Adjusts Autopilot tone and content based on user's life stage (D36).

---

## AP-0805 — Overload Detection & Throttle

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Before sending any notification |
| **Skill** | `vitana-personalization` |

**What it does:**
Uses D51 Overload Detection to prevent notification fatigue. Throttles Autopilot actions when user shows signs of overload.

**Actions:**
1. Check overload signals before any push
2. If overloaded: defer non-critical notifications, reduce frequency
3. Only P0 (safety/payment) notifications bypass overload protection
