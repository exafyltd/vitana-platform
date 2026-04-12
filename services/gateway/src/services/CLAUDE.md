# src/services/ — Business Logic (110+ files)

## How Services Work

Services contain business logic consumed by route handlers. They're functional modules (export functions, not classes). Route files call service functions, services call Prisma/Supabase/external APIs.

## Core Services

### Autopilot System (XState-based)
| File | Purpose |
|------|---------|
| `autopilot-controller.ts` | XState state machine for autopilot flow |
| `autopilot-event-loop.ts` | Event-driven autopilot execution cycle |
| `autopilot-event-mapper.ts` | Maps events to autopilot actions |
| `autopilot-loop-store.ts` | Autopilot loop state persistence |
| `autopilot-prompts-service.ts` | Prompt template management |
| `autopilot-validator.ts` | Autopilot action validation |
| `autopilot-verification.ts` | Autopilot result verification |

### AI & Assistant
| File | Purpose |
|------|---------|
| `assistant-core.ts` | Core Maxina AI assistant logic |
| `assistant-service.ts` | Assistant service interface |
| `ai-orchestrator.ts` | AI model orchestration |
| `ai-personality-service.ts` | Personality parameter management |
| `gemini-operator.ts` | Google Gemini API client |
| `llm-routing-policy-service.ts` | LLM model routing decisions |
| `llm-telemetry-service.ts` | LLM usage telemetry |
| `intent-detection-engine.ts` | User intent detection |
| `response-framing-service.ts` | Response framing/formatting |
| `safety-guardrails.ts` | AI safety guardrails |
| `safety-guardrail-rules.ts` | Safety rule definitions |

### Memory & Knowledge
| File | Purpose |
|------|---------|
| `memory-facts-service.ts` | Memory fact extraction and storage |
| `memory-indexer-client.ts` | Memory indexer API client |
| `memory-relevance-scoring.ts` | Memory relevance scoring |
| `memory-source-config.ts` | Memory source configuration |
| `inline-fact-extractor.ts` | Extract facts from conversations inline |
| `extraction-dedup-manager.ts` | Deduplication for extracted facts |
| `session-memory-buffer.ts` | Session-scoped memory buffer |
| `orb-memory-bridge.ts` | Bridge between voice orb and memory |
| `supabase-semantic-memory.ts` | Semantic memory via Supabase |
| `knowledge-hub.ts` | Knowledge base access service |
| `retrieval-router.ts` | Routes retrieval queries to right source |
| `embedding-service.ts` | Vector embedding generation (OpenAI) |

### Context Assembly (the "brain")
| File | Purpose |
|------|---------|
| `context-assembly-engine.ts` | Assembles full user context from all dimensions |
| `context-pack-builder.ts` | Builds context packs for AI consumption |
| `context-window-manager.ts` | Manages context window token budgets |
| `cross-turn-state-engine.ts` | Cross-conversation-turn state tracking |

### Context Dimensions (d28-d51)
| File | Purpose |
|------|---------|
| `d28-emotional-cognitive-engine.ts` | Emotional and cognitive state |
| `d32-situational-awareness-engine.ts` | User situation awareness |
| `d33-availability-readiness-engine.ts` | User availability |
| `d34-environmental-mobility-engine.ts` | Environmental context |
| `d35-social-context-engine.ts` | Social context |
| `d36-financial-monetization-engine.ts` | Financial/wallet state |
| `d38-learning-style-engine.ts` | Learning style adaptation |
| `d39-taste-alignment-service.ts` | Taste/preference alignment |
| `d40-life-stage-awareness-engine.ts` | Life stage context |
| `d41-boundary-consent-engine.ts` | Boundary and consent tracking |
| `d42-context-fusion-engine.ts` | Fuses all context dimensions |
| `d43-longitudinal-adaptation-engine.ts` | Long-term adaptation |
| `d44-signal-detection-engine.ts` | Behavioral signal detection |
| `d45-predictive-risk-forecasting-engine.ts` | Predictive risk forecasting |
| `d46-anticipatory-guidance-engine.ts` | Anticipatory guidance |
| `d47-social-alignment-engine.ts` | Social alignment |
| `d48-opportunity-surfacing-engine.ts` | Opportunity surfacing |
| `d49-risk-mitigation-engine.ts` | Risk mitigation strategies |
| `d50-positive-trajectory-reinforcement-engine.ts` | Positive reinforcement |
| `d51-overload-detection-engine.ts` | Cognitive/information overload detection |

### Recommendation Engine
| Directory/File | Purpose |
|------|---------|
| `recommendation-engine/` | Recommendation engine directory |
| `recommendation-engine/analyzers/` | 28 analyzer templates |
| `recommendation-engine/scheduler.ts` | Daily recommendation scheduler (7 AM UTC) |

### Automation
| File | Purpose |
|------|---------|
| `automation-executor.ts` | Executes automation tasks |
| `automation-registry.ts` | Registry of automatable actions |
| `automation-handlers/` | Handler directory for specific automation types |

### Live Rooms & Communication
| File | Purpose |
|------|---------|
| `daily-client.ts` | Daily.co API client |
| `room-session-manager.ts` | Live room session management |
| `room-state-machine.ts` | Room state tracking |
| `conversation-client.ts` | Conversation/chat client |
| `sse-service.ts` | Server-Sent Events service |

### Worker & Task Management
| File | Purpose |
|------|---------|
| `worker-core-service.ts` | Core worker service |
| `worker-orchestrator-service.ts` | Worker task orchestration |
| `task-intake-service.ts` | Task intake and routing |
| `task-state-query-service.ts` | Task state querying |

### Self-Healing & Diagnostics
| File | Purpose |
|------|---------|
| `self-healing-diagnosis-service.ts` | Diagnose system issues |
| `self-healing-injector-service.ts` | Inject fixes |
| `self-healing-reconciler.ts` | Reconcile expected vs actual state |
| `self-healing-snapshot-service.ts` | System state snapshots |
| `self-healing-spec-service.ts` | Spec compliance checking |

### Notifications & Events
| File | Purpose |
|------|---------|
| `notification-service.ts` | User notification delivery |
| `oasis-event-service.ts` | OASIS event persistence and querying |
| `event-relevance-scoring.ts` | Event relevance for users |
| `event-sync.ts` | Event synchronization |
| `milestone-service.ts` | User milestone tracking |

### User & Profile
| File | Purpose |
|------|---------|
| `personalization-service.ts` | User personalization |
| `user-preference-modeling-service.ts` | Preference modeling |
| `social-connect-service.ts` | Social connection management |
| `proactive-match-messenger.ts` | Match notification messaging |
| `match-tool-handler.ts` | Match tool integration |

### Navigation & Domain
| File | Purpose |
|------|---------|
| `navigator-consult.ts` | Navigator consultation service |
| `domain-routing-service.ts` | Domain routing logic |
| `natural-language-service.ts` | Natural language processing |

### Infrastructure
| File | Purpose |
|------|---------|
| `deploy-orchestrator.ts` | Deployment orchestration |
| `cicd-lock-manager.ts` | CI/CD concurrency lock management |
| `github-service.ts` | GitHub API integration |
| `gchat-notifier.ts` | Google Chat notifications |
| `cognee-extractor-client.ts` | Cognee extraction API client |
| `visual-verification.ts` | Visual verification service |
| `daily-recompute-service.ts` | Daily data recomputation |

### VTID & Governance
| File | Purpose |
|------|---------|
| `vtid-spec-service.ts` | VTID specification service |
| `vtid-sync.ts` | VTID synchronization |
| `spec-quality-agent.ts` | Spec quality assessment |
| `validator-core-service.ts` | Core validation logic |
| `operator-service.ts` | Operator action processing |
| `operator-action-contract.ts` | Operator action contracts |
| `system-controls-service.ts` | System control panel |

### Trust & Safety
| File | Purpose |
|------|---------|
| `trust-repair-service.ts` | Trust score repair |
| `thread-resolution-service.ts` | Thread resolution |

### Other
| File | Purpose |
|------|---------|
| `tool-registry.ts` | Tool registry for AI function calling |
| `skills/` | Skills directory |
| `welcome-chat-service.ts` | Welcome chat flow |
| `sync-brief-formatter.ts` | Sync brief formatting |
| `auto-logger-service.ts` | Auto logging service |
| `auto-logger-metrics.ts` | Auto logger metrics |
| `health-capacity-awareness-engine.ts` | Health capacity awareness |

## Patterns

- Services are functional modules — export named functions
- Database access via Prisma client or Supabase client
- External API calls wrapped in try/catch with proper error handling
- AI services use Gemini/OpenAI/Vertex clients from respective SDK
- Context dimension engines (d28-d51) follow a consistent pattern: analyze user state → return dimension score + signals
- The recommendation engine uses a template-based approach with 28 analyzer templates supporting 8 languages
