# AP-0600: Health & Wellness

> Automations for health data processing with mandatory PHI protection. All health tasks use local LLM (Ollama) only.

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
