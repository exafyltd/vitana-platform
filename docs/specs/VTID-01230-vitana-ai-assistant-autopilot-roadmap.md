# VTID-01230: Vitana AI Assistant Autopilot - Complete Roadmap

**Status:** Approved
**Created:** 2026-02-03
**Owner:** Autopilot Team
**Goal:** Complete the Vitana AI Assistant as the unified autopilot solution

---

## Executive Summary

This roadmap completes the remaining ~20% of the Vitana Autopilot system, transforming it from a development-focused automation tool into a unified AI Assistant capable of autonomous execution across all Vitana domains.

**Current State:** 80% infrastructure complete (Autopilot Controller, Event Loop, Worker Orchestrator, OASIS)
**Target State:** Unified AI Assistant with proactive intelligence and cross-domain task execution

---

## VTID Schedule Overview

| Phase | VTIDs | Focus | Duration |
|-------|-------|-------|----------|
| **Phase 1** | 01230-01234 | Unified Interface | Week 1-2 |
| **Phase 2** | 01235-01238 | Quick Actions | Week 2-3 |
| **Phase 3** | 01239-01243 | Proactive Intelligence | Week 3-4 |
| **Phase 4** | 01244-01248 | Member Domains | Week 4-6 |
| **Phase 5** | 01249-01251 | Polish & Observability | Week 6-7 |

**Total: 22 VTIDs over 7 weeks**

---

## Phase 1: Unified Interface (Week 1-2)

### VTID-01230: Intent Router Service
**Priority:** P0 - Critical Path
**Effort:** 3 days
**Dependencies:** None

Central dispatcher that classifies user intent and routes to appropriate handler.

**Deliverables:**
- `POST /api/v1/assistant/intent` - Classify intent from any input
- Intent types: `query`, `quick_action`, `complex_task`, `clarification`
- Confidence scoring with fallback to clarification
- Integration with existing ORB Live and Operator Chat

**Schema:**
```typescript
interface IntentClassification {
  type: 'query' | 'quick_action' | 'complex_task' | 'clarification';
  confidence: number;
  action?: string;           // For quick_action: 'book_session', 'reorder', etc.
  vtid_required?: boolean;   // For complex_task
  suggested_response?: string; // For clarification
  routing_target: 'knowledge' | 'quick_executor' | 'autopilot' | 'human';
}
```

---

### VTID-01231: Unified Assistant API Surface
**Priority:** P0 - Critical Path
**Effort:** 2 days
**Dependencies:** VTID-01230

Single `/api/v1/assistant/*` surface that handles all modalities.

**Deliverables:**
- `POST /api/v1/assistant/message` - Unified message endpoint
- `POST /api/v1/assistant/voice` - Voice input handler
- `GET /api/v1/assistant/context` - Current conversation context
- `POST /api/v1/assistant/feedback` - User feedback on responses
- WebSocket support for streaming responses

**Unifies:**
- Dev ORB (`/api/v1/orb-live/*`)
- Operator Chat (`/api/v1/operator/*`)
- Autopilot Commands (`/api/v1/autopilot/*`)

---

### VTID-01232: Assistant Session Manager
**Priority:** P1
**Effort:** 2 days
**Dependencies:** VTID-01231

Manages conversation state and context across interactions.

**Deliverables:**
- Session creation/resumption
- Context window management
- Memory integration (link to existing memory system)
- Multi-turn conversation tracking
- Session timeout and cleanup

**Schema:**
```sql
CREATE TABLE assistant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  context JSONB DEFAULT '{}',
  mode TEXT DEFAULT 'chat', -- chat, voice, proactive
  status TEXT DEFAULT 'active', -- active, idle, ended
  messages_count INTEGER DEFAULT 0
);
```

---

### VTID-01233: Assistant UI Shell (Command Hub Integration)
**Priority:** P1
**Effort:** 3 days
**Dependencies:** VTID-01231, VTID-01232

Unified assistant interface in Command Hub.

**Deliverables:**
- Chat panel with streaming responses
- Voice input toggle (connects to Voice Lab)
- Action confirmation dialogs
- Task progress indicators (links to VTID status)
- Proactive notification badges

---

### VTID-01234: Assistant Handoff Protocol
**Priority:** P1
**Effort:** 1 day
**Dependencies:** VTID-01230

Protocol for escalating from AI to human operators.

**Deliverables:**
- Handoff trigger conditions (low confidence, user request, safety)
- Context packaging for human review
- Smooth transition UX
- Handoff tracking and metrics

---

## Phase 2: Quick Actions (Week 2-3)

### VTID-01235: Quick Action Registry
**Priority:** P0 - Critical Path
**Effort:** 2 days
**Dependencies:** VTID-01230

Registry of pre-approved, lightweight actions that don't need full VTID workflow.

**Deliverables:**
- `quick_actions` table with action definitions
- Safety classification (green/yellow/red)
- Parameter schemas per action
- Tenant-level enable/disable

**Initial Quick Actions:**
| Action | Safety | Parameters |
|--------|--------|------------|
| `book_session` | green | provider_id, date, time |
| `reorder_product` | green | product_id, quantity |
| `send_reminder` | green | message, time |
| `log_metric` | green | metric_type, value |
| `adjust_target` | yellow | target_type, new_value |
| `cancel_booking` | yellow | booking_id, reason |

---

### VTID-01236: Quick Action Executor
**Priority:** P0 - Critical Path
**Effort:** 3 days
**Dependencies:** VTID-01235

Lightweight execution engine for quick actions (no VTID, immediate response).

**Deliverables:**
- `POST /api/v1/assistant/action/execute` - Execute quick action
- `POST /api/v1/assistant/action/preview` - Preview without executing
- Parameter validation
- Confirmation flow for yellow-safety actions
- OASIS event emission (for audit)

**Flow:**
```
User: "Book me a massage tomorrow at 3pm"
     ↓
Intent Router → quick_action: book_session
     ↓
Quick Executor → Check availability → Confirm with user
     ↓
User: "Yes"
     ↓
Execute → OASIS event → Confirmation
```

---

### VTID-01237: Quick Action Undo System
**Priority:** P2
**Effort:** 2 days
**Dependencies:** VTID-01236

Allow users to undo recent quick actions within a time window.

**Deliverables:**
- Undo window (default 5 minutes)
- `POST /api/v1/assistant/action/undo` endpoint
- Undo eligibility check per action type
- Undo execution with rollback

---

### VTID-01238: Quick Action Rate Limiter
**Priority:** P1
**Effort:** 1 day
**Dependencies:** VTID-01236

Prevent abuse and accidental rapid-fire actions.

**Deliverables:**
- Per-user rate limits
- Per-action-type limits
- Cooldown periods for certain actions
- Override for emergency actions

---

## Phase 3: Proactive Intelligence (Week 3-4)

### VTID-01239: Complete VTID-01185 Recommendation Engine
**Priority:** P0 - Critical Path
**Effort:** 4 days
**Dependencies:** None (parallel track)

Complete the recommendation engine spec from VTID-01185.

**Deliverables:**
- Phase 1: Codebase Analyzer (TODO scanner, test coverage)
- Phase 2: OASIS Event Analyzer (error patterns, bottlenecks)
- Deduplication engine
- Manual + scheduled triggers

---

### VTID-01240: Proactive Signal Processor
**Priority:** P1
**Effort:** 3 days
**Dependencies:** VTID-01239

Connect D44 predictive signals to assistant actions.

**Deliverables:**
- Signal-to-action mapping
- Confidence thresholds for proactive suggestions
- User preference integration (opt-in/opt-out per signal type)
- Notification delivery via assistant

**Signal Types:**
| D44 Signal | Suggested Action |
|------------|------------------|
| health_drift | Suggest health check-in |
| routine_instability | Offer routine adjustment |
| social_withdrawal | Suggest community event |
| positive_momentum | Celebrate + reinforce |

---

### VTID-01241: Context-Aware Suggestions
**Priority:** P1
**Effort:** 2 days
**Dependencies:** VTID-01240

Use memory + health data to surface timely recommendations.

**Deliverables:**
- Time-of-day aware suggestions
- Location-aware suggestions (if available)
- Recent activity integration
- Suggestion fatigue management

---

### VTID-01242: Proactive Notification Manager
**Priority:** P1
**Effort:** 2 days
**Dependencies:** VTID-01240, VTID-01241

Manage when and how proactive suggestions are delivered.

**Deliverables:**
- Quiet hours support
- Notification batching
- Priority-based interruption levels
- Delivery channel selection (push, email, in-app)

---

### VTID-01243: Autonomous Routines
**Priority:** P2
**Effort:** 3 days
**Dependencies:** VTID-01236, VTID-01240

Pre-approved recurring actions (morning routine, evening wind-down).

**Deliverables:**
- Routine definition schema
- Routine execution engine
- Skip/snooze functionality
- Routine effectiveness tracking

**Example Routine:**
```json
{
  "name": "Morning Kickstart",
  "trigger": { "type": "time", "value": "07:00" },
  "actions": [
    { "type": "query", "prompt": "weather_briefing" },
    { "type": "query", "prompt": "calendar_preview" },
    { "type": "quick_action", "action": "log_metric", "params": { "metric": "morning_mood" } }
  ]
}
```

---

## Phase 4: Member-Facing Domains (Week 4-6)

### VTID-01244: Health Domain Actions
**Priority:** P1
**Effort:** 3 days
**Dependencies:** VTID-01236

Extend quick actions for health domain.

**New Actions:**
| Action | Safety | Description |
|--------|--------|-------------|
| `log_biomarker` | green | Log health metric |
| `request_lab` | yellow | Request lab test |
| `schedule_checkup` | yellow | Schedule health checkup |
| `adjust_health_goal` | yellow | Modify health targets |

**Integration:**
- Connect to health capacity system
- Connect to D44 signals
- Connect to user preferences

---

### VTID-01245: Scheduling Domain Actions
**Priority:** P1
**Effort:** 2 days
**Dependencies:** VTID-01236

Calendar and scheduling actions.

**New Actions:**
| Action | Safety | Description |
|--------|--------|-------------|
| `book_session` | green | Book provider session |
| `reschedule` | yellow | Move existing booking |
| `cancel_booking` | yellow | Cancel with reason |
| `set_reminder` | green | Create reminder |
| `block_time` | green | Block calendar time |

---

### VTID-01246: Product & Ordering Domain Actions
**Priority:** P2
**Effort:** 2 days
**Dependencies:** VTID-01236

Ordering and product management.

**New Actions:**
| Action | Safety | Description |
|--------|--------|-------------|
| `reorder_product` | green | Reorder from history |
| `add_to_list` | green | Add to shopping list |
| `pause_subscription` | yellow | Pause recurring order |
| `rate_product` | green | Rate used product |

---

### VTID-01247: Community Domain Actions
**Priority:** P2
**Effort:** 2 days
**Dependencies:** VTID-01236

Community and social actions.

**New Actions:**
| Action | Safety | Description |
|--------|--------|-------------|
| `join_event` | green | RSVP to live event |
| `leave_event` | green | Cancel RSVP |
| `send_kudos` | green | Send appreciation |
| `request_intro` | yellow | Request introduction |

---

### VTID-01248: Domain Safety Rules Engine
**Priority:** P1
**Effort:** 2 days
**Dependencies:** VTID-01244, VTID-01245, VTID-01246, VTID-01247

Centralized safety rules for all domain actions.

**Deliverables:**
- Rule definition language
- Rule evaluation engine
- Safety override with audit
- Domain-specific constraints (budget limits, health guidelines)

---

## Phase 5: Polish & Observability (Week 6-7)

### VTID-01249: Assistant Health Dashboard
**Priority:** P1
**Effort:** 2 days
**Dependencies:** All Phase 1-4 VTIDs

Self-diagnostics and health monitoring for the assistant.

**Deliverables:**
- `GET /api/v1/assistant/health` - Health check endpoint
- Intent classification accuracy metrics
- Action success/failure rates
- Response latency percentiles
- User satisfaction tracking

---

### VTID-01250: Assistant Analytics Pipeline
**Priority:** P2
**Effort:** 2 days
**Dependencies:** VTID-01249

Analytics for assistant usage and improvement.

**Deliverables:**
- Usage patterns by domain
- Common intent types
- Failed intent classifications
- Action completion rates
- Feedback aggregation

---

### VTID-01251: Assistant A/B Testing Framework
**Priority:** P2
**Effort:** 2 days
**Dependencies:** VTID-01250

Test different assistant behaviors.

**Deliverables:**
- Experiment definition
- Traffic splitting
- Metric collection per variant
- Statistical significance calculation

---

## Dependency Graph

```
Week 1-2 (Phase 1: Unified Interface)
┌─────────────────────────────────────────────────────────────────┐
│  VTID-01230 (Intent Router) ──────────────────────┐             │
│       │                                           │             │
│       ▼                                           ▼             │
│  VTID-01231 (Unified API) ─────────────► VTID-01234 (Handoff)  │
│       │                                                         │
│       ▼                                                         │
│  VTID-01232 (Session Manager)                                   │
│       │                                                         │
│       ▼                                                         │
│  VTID-01233 (UI Shell)                                          │
└─────────────────────────────────────────────────────────────────┘

Week 2-3 (Phase 2: Quick Actions)
┌─────────────────────────────────────────────────────────────────┐
│  VTID-01235 (Action Registry) ───┐                              │
│       │                          │                              │
│       ▼                          ▼                              │
│  VTID-01236 (Executor) ──► VTID-01238 (Rate Limiter)           │
│       │                                                         │
│       ▼                                                         │
│  VTID-01237 (Undo System)                                       │
└─────────────────────────────────────────────────────────────────┘

Week 3-4 (Phase 3: Proactive Intelligence)
┌─────────────────────────────────────────────────────────────────┐
│  VTID-01239 (Rec Engine) ────────┐                              │
│                                  │                              │
│  VTID-01240 (Signal Processor) ◄─┘                              │
│       │                                                         │
│       ├──────────────────┐                                      │
│       ▼                  ▼                                      │
│  VTID-01241 (Suggestions) VTID-01242 (Notifications)            │
│       │                  │                                      │
│       └────────┬─────────┘                                      │
│                ▼                                                │
│  VTID-01243 (Autonomous Routines)                               │
└─────────────────────────────────────────────────────────────────┘

Week 4-6 (Phase 4: Member Domains)
┌─────────────────────────────────────────────────────────────────┐
│  From VTID-01236 (Executor)                                     │
│       │                                                         │
│       ├───────────┬───────────┬───────────┐                    │
│       ▼           ▼           ▼           ▼                    │
│  VTID-01244  VTID-01245  VTID-01246  VTID-01247                │
│  (Health)    (Schedule)  (Products)  (Community)               │
│       │           │           │           │                    │
│       └───────────┴───────────┴───────────┘                    │
│                       │                                         │
│                       ▼                                         │
│               VTID-01248 (Safety Rules)                         │
└─────────────────────────────────────────────────────────────────┘

Week 6-7 (Phase 5: Polish)
┌─────────────────────────────────────────────────────────────────┐
│  VTID-01249 (Health Dashboard)                                  │
│       │                                                         │
│       ▼                                                         │
│  VTID-01250 (Analytics Pipeline)                                │
│       │                                                         │
│       ▼                                                         │
│  VTID-01251 (A/B Testing)                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Weekly Execution Schedule

### Week 1 (Feb 3-7)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon-Tue | 01230 | Intent Router Service | Backend |
| Tue-Wed | 01231 | Unified Assistant API | Backend |
| Thu | 01234 | Handoff Protocol | Backend |
| Fri | 01232 | Session Manager (start) | Backend |

### Week 2 (Feb 10-14)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon | 01232 | Session Manager (complete) | Backend |
| Tue-Thu | 01233 | Assistant UI Shell | Frontend |
| Wed-Thu | 01235 | Quick Action Registry | Backend |
| Fri | 01238 | Rate Limiter | Backend |

### Week 3 (Feb 17-21)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon-Wed | 01236 | Quick Action Executor | Backend |
| Thu-Fri | 01237 | Undo System | Backend |
| Mon-Thu | 01239 | Recommendation Engine (parallel) | AI Team |

### Week 4 (Feb 24-28)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon-Wed | 01240 | Proactive Signal Processor | AI Team |
| Wed-Thu | 01241 | Context-Aware Suggestions | AI Team |
| Fri | 01242 | Notification Manager (start) | Backend |

### Week 5 (Mar 3-7)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon | 01242 | Notification Manager (complete) | Backend |
| Tue-Thu | 01243 | Autonomous Routines | Backend |
| Mon-Wed | 01244 | Health Domain Actions (parallel) | Domain |
| Wed-Thu | 01245 | Scheduling Domain Actions | Domain |

### Week 6 (Mar 10-14)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon-Tue | 01246 | Product & Ordering Domain | Domain |
| Tue-Wed | 01247 | Community Domain Actions | Domain |
| Thu-Fri | 01248 | Domain Safety Rules Engine | Backend |

### Week 7 (Mar 17-21)
| Day | VTID | Task | Owner |
|-----|------|------|-------|
| Mon-Tue | 01249 | Assistant Health Dashboard | DevOps |
| Wed-Thu | 01250 | Analytics Pipeline | Data |
| Thu-Fri | 01251 | A/B Testing Framework | Data |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Intent classification accuracy | >90% | Correct routing rate |
| Quick action success rate | >95% | Completed without error |
| Average response time | <2s | P95 latency |
| User satisfaction | >4.5/5 | Post-interaction rating |
| Proactive acceptance rate | >30% | Suggestions acted upon |
| Undo usage | <5% | Actions requiring undo |
| Handoff rate | <10% | Escalations to human |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Scope creep | Schedule slip | Strict VTID boundaries, no feature additions mid-sprint |
| LLM latency | Poor UX | Streaming responses, optimistic UI updates |
| Safety incidents | Trust loss | Red-safety actions require explicit confirmation |
| Integration complexity | Bugs | Extensive integration tests, gradual rollout |
| User adoption | Low ROI | Early user feedback, iterate on UX |

---

## Governance Checkpoints

| Checkpoint | Criteria | Gate |
|------------|----------|------|
| Phase 1 Complete | All 5 VTIDs merged | Can proceed to Phase 2 |
| Phase 2 Complete | Quick actions working E2E | Can proceed to Phase 3 |
| Phase 3 Complete | Proactive suggestions live | Can proceed to Phase 4 |
| Phase 4 Complete | All domains enabled | Can proceed to Phase 5 |
| Phase 5 Complete | Observability in place | GA Release |

---

## Appendix: VTID Summary Table

| VTID | Title | Phase | Priority | Effort | Dependencies |
|------|-------|-------|----------|--------|--------------|
| 01230 | Intent Router Service | 1 | P0 | 3d | None |
| 01231 | Unified Assistant API | 1 | P0 | 2d | 01230 |
| 01232 | Assistant Session Manager | 1 | P1 | 2d | 01231 |
| 01233 | Assistant UI Shell | 1 | P1 | 3d | 01231, 01232 |
| 01234 | Assistant Handoff Protocol | 1 | P1 | 1d | 01230 |
| 01235 | Quick Action Registry | 2 | P0 | 2d | 01230 |
| 01236 | Quick Action Executor | 2 | P0 | 3d | 01235 |
| 01237 | Quick Action Undo System | 2 | P2 | 2d | 01236 |
| 01238 | Quick Action Rate Limiter | 2 | P1 | 1d | 01236 |
| 01239 | Recommendation Engine (Complete) | 3 | P0 | 4d | None |
| 01240 | Proactive Signal Processor | 3 | P1 | 3d | 01239 |
| 01241 | Context-Aware Suggestions | 3 | P1 | 2d | 01240 |
| 01242 | Proactive Notification Manager | 3 | P1 | 2d | 01240, 01241 |
| 01243 | Autonomous Routines | 3 | P2 | 3d | 01236, 01240 |
| 01244 | Health Domain Actions | 4 | P1 | 3d | 01236 |
| 01245 | Scheduling Domain Actions | 4 | P1 | 2d | 01236 |
| 01246 | Product & Ordering Domain | 4 | P2 | 2d | 01236 |
| 01247 | Community Domain Actions | 4 | P2 | 2d | 01236 |
| 01248 | Domain Safety Rules Engine | 4 | P1 | 2d | 01244-01247 |
| 01249 | Assistant Health Dashboard | 5 | P1 | 2d | All |
| 01250 | Assistant Analytics Pipeline | 5 | P2 | 2d | 01249 |
| 01251 | A/B Testing Framework | 5 | P2 | 2d | 01250 |

**Total Effort:** ~47 days of work across ~7 calendar weeks with parallelization

---

*This roadmap completes the Vitana AI Assistant Autopilot vision using existing infrastructure, without requiring external dependencies like OpenClaw.*
