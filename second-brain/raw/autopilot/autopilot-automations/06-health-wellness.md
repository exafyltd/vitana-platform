# AP-0600: Health & Wellness

> Automations for health data processing, medical report analysis, biomarker tracking, quality-of-life recommendations, and Vitana Index optimization. **All health tasks use local LLM (Ollama) only** — no PHI leaves the server.

---

## AP-0601 — PHI Redaction Gate

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Any task containing health/personal data |
| **Skill** | `vitana-health` |

**What it does:**
Mandatory middleware that redacts PHI before any data reaches an external LLM.

**Actions:**
1. Pattern-based detection: names, dates, conditions, MRNs, SSNs, emails, phones, addresses
2. Replace with type placeholders: `[PERSON]`, `[MEDICAL_CONDITION]`, etc.
3. Route redacted content to Ollama (local) for health tasks
4. Emit OASIS event `openclaw.phi_detected` when PHI found

**Notes:** Already implemented in OpenClaw bridge `phi-redactor.ts`.

---

## AP-0602 — Health Report Summarization

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Health report status = `pending_summary` |
| **Skill** | `vitana-health` |

**What it does:**
Summarizes health reports using LOCAL Ollama LLM. No health data leaves the server.

**Actions:**
1. Fetch report from DB, redact PHI (defense in depth)
2. Summarize via Ollama `llama3.1:8b`
3. Double-redact the output
4. Store summary, update status to `summarized`

**Notes:** Already implemented in OpenClaw bridge. Runs in heartbeat loop.

---

## AP-0603 — Consent Check Before Health Operations

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Before any health data processing |
| **Skill** | `vitana-health` |

**What it does:**
Checks user consent in `user_consents` table before any health data operation.

**Notes:** Already implemented. Hard gate — blocks execution if no consent.

---

## AP-0604 — Wellness Check-In Prompt

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly or based on Vitana Index decline |
| **Skill** | `vitana-health` |

**What it does:**
Sends a gentle wellness check-in when health signals suggest the user might benefit from engagement.

**Actions:**
1. Query `vitana_index_scores` for declining trends
2. If decline detected, send: _"How are you feeling this week? Your ORB is here to chat."_
3. Never mention specific health conditions in push notifications
4. Link to ORB assistant for private conversation

---

## AP-0605 — Community Wellness Event Suggestion

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | User's wellness goals align with a community event |
| **Skill** | `vitana-health` + `vitana-community` |

**What it does:**
Suggests wellness-related meetups and groups that align with user's health goals.

**Actions:**
1. Cross-reference wellness goals with available meetups/groups
2. Suggest: _"[Group] focuses on [wellness_topic] — matches your goals"_
3. Never expose specific health data in social contexts

---

## AP-0606 — Health Data Export Reminder

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Quarterly (every 90 days) |
| **Skill** | `vitana-health` |

**What it does:**
Reminds users they can export their health data (GDPR compliance).

---

## AP-0607 — Lab Report Ingestion & Biomarker Extraction

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | User uploads a lab report (PDF/image) |
| **Skill** | `vitana-health` |

**What it does:**
Automatically parses uploaded lab reports, extracts biomarker values, and stores them in `biomarker_results` with status classification (low/normal/high/critical).

**Actions:**
1. Receive upload via `POST /api/v1/health/lab-reports/ingest`
2. Run OCR / PDF extraction (local processing only)
3. Parse biomarker values: CRP, HbA1c, glucose, lipid panel, vitamin D, hormones, ferritin, B12, folate, liver enzymes, kidney function
4. For each biomarker: determine `status` against reference ranges (low/normal/high/critical)
5. Store in `biomarker_results` with `lab_report_id` reference
6. Trigger AP-0608 (trend analysis) if previous results exist
7. Emit OASIS event `autopilot.health.lab_report_ingested`

**APIs used:**
- `POST /api/v1/health/lab-reports/ingest` (VTID-01081)
- `biomarker_results` table

**Database tables:**
- `lab_reports` — raw report storage
- `biomarker_results` — individual biomarker measurements with status

**Safety:**
- AP-0601 (PHI Redaction) runs BEFORE any processing
- AP-0603 (Consent Check) must pass
- All processing on local Ollama — never external LLM

---

## AP-0608 — Biomarker Trend Analysis

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | New biomarker results stored (after AP-0607) |
| **Skill** | `vitana-health` |

**What it does:**
Compares new biomarker values against historical results to detect trends (improving, stable, declining, critical shift). Feeds trend data into the Vitana Index.

**Actions:**
1. Query `biomarker_results` for same user + same `biomarker_code` (last 12 months)
2. Compute trend: direction (up/down/stable), velocity (fast/slow), trajectory (improving/worsening)
3. Flag critical shifts: any biomarker that moved from `normal` to `high`/`critical` in one test
4. Store trend summary in `health_features_daily`
5. Trigger `POST /api/v1/health/recompute/daily` to update Vitana Index
6. If critical shift detected: trigger AP-0612 (Professional Referral Suggestion)
7. Emit OASIS event `autopilot.health.biomarker_trend_computed`

**APIs used:**
- `POST /api/v1/health/recompute/daily` (VTID-01103)
- `biomarker_results`, `health_features_daily` tables

**Success metric:** % of users who take action on trend alerts within 7 days

**Requires:** AP-0607

---

## AP-0609 — Quality-of-Life Recommendation Engine

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | After daily recompute or new lab results |
| **Skill** | `vitana-health` |

**What it does:**
Generates personalized quality-of-life recommendations based on health data, biomarkers, wearable trends, and Vitana Index scores. Recommendations span all 7 pillars: nutrition, hydration, exercise, sleep, mental health, social bonds, and purpose.

**Actions:**
1. Gather context: `vitana_index_scores` (pillar scores), `biomarker_results` (latest), `wearable_samples` (7-day trends), `health_features_daily`
2. Identify weakest pillars (score < 50) and highest-impact interventions
3. Generate recommendations using local Ollama LLM (never external):
   - Nutrition: _"Your inflammation markers (CRP) suggest adding omega-3 rich foods"_
   - Sleep: _"Your HRV data shows poor recovery — try a consistent bedtime routine"_
   - Exercise: _"Your resting heart rate improved 5% — keep up the cardio"_
   - Social: _"Your social engagement dropped — join a community meetup this week"_
4. Check `safety_constraints` table — never contradict medical advice
5. Store in `recommendations` table with pillar, confidence, and evidence source
6. Surface via ORB conversation (not push notifications for health specifics)
7. Emit OASIS event `autopilot.health.recommendations_generated`

**APIs used:**
- `POST /api/v1/health/recompute/daily` (VTID-01103)
- `GET /api/v1/health/summary` (VTID-01081)
- `vitana_index_scores`, `recommendations`, `safety_constraints` tables

**Safety:**
- Never diagnose — only suggest lifestyle adjustments
- Always add: _"Talk to your health professional about any concerns"_
- Never recommend stopping medication or treatments
- PHI-redacted before any recommendation text is sent to push

**Success metric:** Vitana Index improvement in users who follow recommendations vs. control

---

## AP-0610 — Wearable Data Anomaly Detection

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Wearable data ingested via `POST /api/v1/health/wearables/ingest` |
| **Skill** | `vitana-health` |

**What it does:**
Detects anomalies in wearable data streams (sudden resting heart rate spike, sleep duration crash, HRV collapse) and triggers a gentle wellness check.

**Actions:**
1. Receive `wearable_samples` for `device_type` (apple_watch, fitbit, garmin, oura, whoop)
2. Compare against user's 30-day baseline for each `metric_type`
3. Detect anomalies: >2 standard deviations from baseline
4. If anomaly detected: trigger AP-0604 (Wellness Check-In Prompt) with context
5. If 3+ anomalies in 7 days: suggest scheduling a health review
6. Emit OASIS event `autopilot.health.anomaly_detected`

**APIs used:**
- `POST /api/v1/health/wearables/ingest` (VTID-01081)
- `wearable_samples`, `health_features_daily` tables

**Notes:**
- Anomaly detection runs locally — no wearable data sent externally
- Notifications are generic: _"Your sleep pattern changed this week — want to talk about it?"_
- Never mention specific values in push notifications

---

## AP-0611 — Vitana Index Weekly Report

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Weekly (Monday morning with briefing) |
| **Skill** | `vitana-health` |

**What it does:**
Generates a weekly Vitana Index report showing pillar scores, trends, and the single highest-impact action the user can take this week.

**Actions:**
1. Query `vitana_index_scores` for last 7 days
2. Compute per-pillar trends: nutrition, hydration, exercise, sleep, mental health, social, purpose
3. Identify the weakest pillar and the most impactful intervention
4. Send via ORB conversation (not push — too detailed for notification):
   _"Your Vitana Index this week: [score]. Your strongest pillar: [pillar]. This week, focus on [weakest pillar] — here's one thing you can do: [recommendation]"_
5. Include comparison to last week (improving/stable/declining)
6. Emit OASIS event `autopilot.health.weekly_index_report`

**APIs used:**
- `GET /api/v1/health/summary`
- `vitana_index_scores` table

**Requires:** AP-0609

---

## AP-0612 — Professional Referral Suggestion

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P0` |
| **Trigger** | Critical biomarker detected (AP-0608) or safety constraint triggered |
| **Skill** | `vitana-health` + `vitana-community` |

**What it does:**
When health data suggests professional attention is needed, suggests relevant health professionals from the Discover marketplace (doctors, coaches, nutritionists) — connecting health insights to business.

**Actions:**
1. Detect trigger: critical biomarker status OR safety constraint match
2. Query `services_catalog` for matching `service_type` (doctor, coach, nutritionist, therapist, fitness)
3. Filter by `topic_keys` alignment with health concern
4. Suggest via ORB: _"Based on your recent results, you might benefit from speaking with a [service_type]. Here are some options on Vitana."_
5. Link to Discover section with pre-filtered results
6. Create `relationship_edge` (type: `suggested`, origin: `autopilot_health`)
7. Emit OASIS event `autopilot.health.professional_suggested`

**APIs used:**
- `GET /api/v1/offers/recommendations` (VTID-01092)
- `services_catalog`, `relationship_edges` tables

**Safety:**
- NEVER say "you need a doctor" — frame as _"you might benefit from"_
- Never expose specific biomarker values in notifications
- Always respect user preference for suggestion frequency

**Cross-references:** AP-1101 (service listing in marketplace)

---

## AP-0613 — Health Capacity Awareness for Autopilot

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Before any social/engagement suggestion |
| **Skill** | `vitana-health` |

**What it does:**
Uses the D32 Health Capacity Awareness Engine (VTID-01122) to gate Autopilot actions. If a user's health capacity is low, reduces social pressure and engagement nudges.

**Actions:**
1. Query health capacity score from D32 engine
2. If capacity LOW: suppress AP-0102 nudges, AP-0503 re-engagement, AP-0507 conversation nudges
3. If capacity CRITICAL: only allow AP-0604 (wellness check-in) — no social, no business
4. If capacity NORMAL/HIGH: proceed with all automations
5. Emit OASIS event `autopilot.health.capacity_gate_applied`

**APIs used:**
- Health Capacity Awareness Engine (VTID-01122)
- `health_features_daily` table

**Notes:** This is a cross-cutting concern that affects ALL other AP domains. Critical for ethical automation.

---

## AP-0614 — Health Goal Setting Assistant

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | After first lab report upload or quarterly |
| **Skill** | `vitana-health` |

**What it does:**
Helps users set realistic health goals based on their current biomarkers and Vitana Index. Tracks progress toward goals.

**Actions:**
1. After first lab report: _"Great! Based on your results, let's set some goals. Which pillar matters most to you?"_
2. Present pillar options with current scores
3. For chosen pillar, suggest SMART goals (e.g., "Improve sleep score from 45 to 60 in 30 days")
4. Track weekly progress against goals
5. Celebrate when goals are met (link to AP-0504 milestones)

---

## AP-0615 — Health-Aware Product Recommendations

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | After health recommendations generated (AP-0609) |
| **Skill** | `vitana-health` + `vitana-marketplace` |

**What it does:**
Connects health insights to relevant products in the Discover marketplace (supplements, devices, wearables, apps) — ethically and with full transparency.

**Actions:**
1. After AP-0609 generates recommendations, check if any map to products in `products_catalog`
2. Example: recommendation "increase omega-3" → suggest omega-3 supplements from marketplace
3. Check D36 monetization readiness (AP-0805 overload detection) — never push products when vulnerable
4. Surface via ORB: _"I noticed [recommendation]. If you're interested, there are some options in Discover."_
5. Track via `user_offers_memory` (state: viewed → saved → used)
6. Monitor `usage_outcomes` for product effectiveness feedback

**APIs used:**
- `GET /api/v1/offers/recommendations` (VTID-01092)
- `products_catalog`, `user_offers_memory`, `usage_outcomes` tables
- D36 Financial Monetization Engine (VTID-01130)

**Safety:**
- NEVER push products during emotional vulnerability (AP-0613 health capacity check)
- Always lead with VALUE, never with price
- Never stack multiple product suggestions
- Explicit user "no" blocks product suggestions immediately

**Cross-references:** AP-1102 (product listings), AP-0805 (overload detection)
