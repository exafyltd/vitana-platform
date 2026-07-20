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

---

## AP-0906 — Routine Pattern Extraction

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, daily 3:30am |
| **Handler** | `runRoutinePatternExtraction` |

**What it does:**
Fans `extractPatternsForUser` (guide/pattern-extractor, VTID-01936 — previously caller-less) over users with calendar activity in the last 30 days, writing time-of-day / day-of-week / category-affinity routines to `user_routines`. The UserContextProfiler and guide awareness-context read that table, so routines flow into the ORB voice profile.

---

## AP-0907 — Daily Learning Digest

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, daily 18:10 |
| **Handler** | `runDailyLearningDigest` |

**What it does:**
The standalone half of the shared felt-learning detector (`conversation/new-facts-detector.ts`): notifies users who gained `memory_facts` in the last 24h but did not get the moment in a session (greeting-ledger `facts_learned` not spoken today, `learning_surfaced_v1` not stamped today). Localized via the gateway i18n catalog; silent when nothing new.

---

## AP-0908 — Behavior-Derived Preference Inference

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, daily 4:40am |
| **Handler** | `runBehaviorPreferenceInference` |

**What it does:**
Turns AP-0906's `user_routines` (confidence ≥ 0.6) into `user_preference_*` memory facts via `write_fact` — provenance `behavior_inferred`, confidence 0.55. Idempotent: identical values are skipped, so re-runs cause no supersession churn.

---

## AP-0909 — Relationship Graph Projection

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, daily 3:50am |
| **Handler** | `runRelationshipGraphProjection` |

**What it does:**
The graph as a DERIVED INDEX (the only creation path since Cognee's Phase 8 retirement): projects person-facts (`spouse_name`, `friend_name_*`, …) into `relationship_nodes` + person→node relation edges, and mutual follows into person↔person `connected` edges (the shape AP-0801 counts). Rebuildable from source data at any time; Loop 13 (nightly consolidator) is the single decay mechanism. **AP-0903 is retired** — its conflicting decay formula double-decayed the same rows.

---

## AP-0910 — Memory Embedding Backfill

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, hourly at :25 |
| **Handler** | `runMemoryEmbeddingBackfill` |

**What it does:**
Drains the fact-embedding backlog (96% of live facts were unembedded, blinding tier-2 semantic retrieval) in batches of 100 via `generateBatchEmbeddings`. New writes embed inline in the inline-fact-extractor; this catches history and misses. Cheap no-op once the backlog is empty.

---

## AP-0911 — User Model Synthesis

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Cron, daily 5:05am |
| **Handler** | `runUserModelSynthesis` |

**What it does:**
One LLM pass per active user (≥3 facts) connecting facts + routines + active goal + Vitana Index into a compact grounded narrative ("who is this person"), stored in `user_assistant_state` (`user_profile_narrative_v1`) and injected by the UserContextProfiler into the TTL-cached ORB bootstrap — synthesized understanding at zero added latency. Skips users whose inputs hash is unchanged.

---

## AP-0912 — Health Correlation Insights

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P1` |
| **Trigger** | Cron, daily 4:55am |
| **Handler** | `runHealthCorrelationInsights` |

**What it does:**
Deterministic (no-LLM, no hallucinated health claims) correlation rules over `vitana_index_scores` and `diary_entries`: pillar trends (≥10-point move over ~2 weeks) and diary lapses (silent week after a ≥3-entry week) become `health_insight_*` memory facts (provenance `system_observed`, confidence 0.9). Auto-superseded as the picture changes; surfaced through the felt-learning detector and woven into AP-0911 narratives.

## AP-0913 — Own Post Memory Capture

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P2` |
| **Trigger** | Cron, hourly at :15 |
| **Handler** | `runOwnPostMemoryCapture` |

**What it does:**
BOOTSTRAP-MEMORY-DAILY-LEARNING: the community feed (`profile_posts`) never fed the assistant's memory at all, so Vitana could never reference a user's own post ("the post you wrote about X") — confirmed zero references to `profile_posts` anywhere in the extraction pipeline. Scans `profile_posts` created in the last 65 minutes (5-min overlap over the hourly cron cadence) for every origin — app UI posts and voice's `create_community_post` alike — and mirrors each into `memory_items` via `writeMemoryItemWithIdentity` (`source: 'system'`, `content_json: { kind: 'community_post', post_id }`, `occurred_at` = the post's own timestamp). Uses `memory_items` rather than a rolling `memory_facts` row because a feed of posts is naturally many-valued, and the existing EPISODIC fallback ladder in `memory-broker.ts` already retrieves `memory_items` by recency/importance with no further plumbing. Deduplicates against already-mirrored posts (`content_json->>post_id`) so the overlap window never double-writes.
