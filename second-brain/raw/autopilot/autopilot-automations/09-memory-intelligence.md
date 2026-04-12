# AP-0900: Memory & Intelligence

> Automations leveraging Vitana's memory stack (memory_facts, relationship_nodes, memory_items) for intelligent Autopilot behavior.

---

## AP-0901 — Memory-Informed Matching

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Before daily match recompute (AP-0101) |
| **Skill** | `vitana-memory` (NEW) |

**What it does:**
Feeds memory context into the matching algorithm. Uses diary entries, facts, and relationship history to improve match quality.

**Actions:**
1. Query `memory_facts` for user preferences, experiences, stated interests
2. Query `relationship_nodes` for existing connection quality signals
3. Feed context to match scoring: boost matches aligned with memory, dampen repeated mismatches
4. Emit OASIS event `autopilot.memory.match_context_loaded`

**APIs used:**
- `write_fact()` RPC
- Memory retrieval router

---

## AP-0902 — Fact Extraction from Conversations

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | After user conversation with ORB |
| **Skill** | `vitana-memory` |

**What it does:**
Extracts relevant facts from ORB conversations and stores them in `memory_facts` for future personalization.

**Actions:**
1. After conversation ends, run Cognee extraction on transcript
2. Store extracted entities and relationships
3. Update `user_topic_profile` from extracted interests
4. Feed into next matching cycle

**APIs used:**
- Cognee extractor service
- `write_fact()` RPC

---

## AP-0903 — Relationship Graph Maintenance

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Weekly heartbeat |
| **Skill** | `vitana-memory` |

**What it does:**
Maintains the relationship graph by updating edge weights based on recent interactions.

**Actions:**
1. Query recent chat activity, meetup co-attendance, match interactions
2. Update `relationship_edges` weights (strengthen active, decay dormant)
3. Identify connection pairs at risk of dormancy
4. Feed into AP-0507 (Conversation Continuity Nudge)

---

## AP-0904 — Semantic Memory Search for Autopilot Context

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Any Autopilot action that needs user context |
| **Skill** | `vitana-memory` |

**What it does:**
Provides semantic memory retrieval for Autopilot actions. Before generating any personalized message, retrieves relevant memories.

**APIs used:**
- Retrieval Router (VTID-01216)
- Context Pack Builder

---

## AP-0905 — Knowledge Base Context for Suggestions

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | Autopilot generates suggestions about Vitana features |
| **Skill** | `vitana-memory` |

**What it does:**
When Autopilot suggests features or explains Vitana concepts, pulls context from the Knowledge Hub.

**APIs used:**
- `POST /api/v1/assistant/knowledge/search`
- Knowledge Hub service (VTID-0538)
