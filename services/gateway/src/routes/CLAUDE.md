# src/routes/ — API Route Files (95+ files)

## How Routes Work

Each file exports an Express Router. Routes are mounted in `src/index.ts`. Most routes use auth middleware for protected endpoints.

## By Domain

### Auth & Access
| File | Prefix | Purpose |
|------|--------|---------|
| `auth.ts` | `/api/v1/auth` | Authentication endpoints |
| `dev-auth.ts` | `/api/v1/dev-auth` | Developer authentication |
| `dev-access.ts` | `/api/v1/dev-access` | Developer access control |

### Autopilot & Recommendations
| File | Prefix | Purpose |
|------|--------|---------|
| `autopilot.ts` | `/api/v1/autopilot` | Autopilot state and actions |
| `autopilot-recommendations.ts` | `/api/v1/autopilot/recommendations` | AI-powered recommendations (28 templates, 8 langs, 6 onboarding stages) |
| `autopilot-prompts.ts` | `/api/v1/autopilot/prompts` | Autopilot prompt management |
| `recommendation-inbox.ts` | `/api/v1/recommendation-inbox` | Recommendation inbox |

### Community & Social
| File | Prefix | Purpose |
|------|--------|---------|
| `community.ts` | `/api/v1/community` | Community features |
| `social-connect.ts` | `/api/v1/social-connect` | Social connections |
| `social-context.ts` | `/api/v1/social-context` | Social context assembly |
| `relationships.ts` | `/api/v1/relationships` | User relationships |
| `matchmaking.ts` | `/api/v1/matchmaking` | User matching |
| `match-feedback.ts` | `/api/v1/match-feedback` | Match quality feedback |

### Messaging & Chat
| File | Prefix | Purpose |
|------|--------|---------|
| `chat.ts` | `/api/v1/chat` | Chat messaging |
| `conversation.ts` | `/api/v1/conversation` | Conversation management |

### Events & Tasks
| File | Prefix | Purpose |
|------|--------|---------|
| `events.ts` | `/api/v1/events` | Event management |
| `tasks.ts` | `/api/v1/tasks` | Task management + SSE streaming |
| `oasis-tasks.ts` | `/api/v1/oasis/tasks` | OASIS task operations |
| `oasis-vtid-ledger.ts` | `/api/v1/oasis/vtid-ledger` | VTID ledger CRUD |
| `scheduler.ts` | `/api/v1/scheduler` | Scheduled task execution |

### Health & Wellness
| File | Prefix | Purpose |
|------|--------|---------|
| `health.ts` | `/api/v1/health` | Health data endpoints |
| `health-capacity.ts` | `/api/v1/health-capacity` | Health capacity awareness |
| `longevity.ts` | `/api/v1/longevity` | Longevity metrics |

### Live Rooms & Voice
| File | Prefix | Purpose |
|------|--------|---------|
| `live.ts` | `/api/v1/live` | Live room management (Daily.co) |
| `orb-live.ts` | `/api/v1/orb-live` | Voice orb live streaming (438KB — largest route) |
| `voice-lab.ts` | `/api/v1/voice-lab` | Voice lab testing |
| `voice-feedback.ts` | `/api/v1/voice-feedback` | Voice quality feedback |

### AI & Intelligence
| File | Prefix | Purpose |
|------|--------|---------|
| `assistant.ts` | `/api/v1/assistant` | AI assistant |
| `ai-personality.ts` | `/api/v1/ai-personality` | AI personality configuration |
| `llm.ts` | `/api/v1/llm` | LLM routing |
| `context.ts` | `/api/v1/context` | Context assembly |

### Memory & Knowledge
| File | Prefix | Purpose |
|------|--------|---------|
| `memory.ts` | `/api/v1/memory` | Memory CRUD |
| `memory-governance.ts` | `/api/v1/memory-governance` | Memory access governance |
| `semantic-memory.ts` | `/api/v1/semantic-memory` | Semantic memory search |
| `specs.ts` | `/api/v1/specs` | Specification access |
| `topics.ts` | `/api/v1/topics` | Topic management |

### Diary & Logging
| File | Prefix | Purpose |
|------|--------|---------|
| `diary.ts` | `/api/v1/diary` | Diary entries |
| `auto-logger-health-route.ts` | `/api/v1/auto-logger` | Auto health logging |

### Admin & Users
| File | Prefix | Purpose |
|------|--------|---------|
| `admin-users.ts` | `/api/v1/admin/users` | User management |
| `admin-tenants.ts` | `/api/v1/admin/tenants` | Tenant management |
| `admin-notifications.ts` | `/api/v1/admin/notifications` | Notification management |
| `admin-signups.ts` | `/api/v1/admin/signups` | Signup management |
| `admin-navigator.ts` | `/api/v1/admin/navigator` | Admin navigation |
| `admin-moderation.ts` | `/api/v1/admin/moderation` | Content moderation |

### Operator & Command Hub
| File | Prefix | Purpose |
|------|--------|---------|
| `operator.ts` | `/api/v1/operator` | Operator actions (deploy, publish) |
| `command-hub.ts` | `/api/v1/command-hub` | Command Hub API |
| `commandhub.ts` | `/api/v1/commandhub` | Command Hub (alternate mount) |

### Governance & VTID
| File | Prefix | Purpose |
|------|--------|---------|
| `vtid.ts` | `/api/v1/vtid` | VTID operations |
| `vtid-terminalize.ts` | `/api/v1/vtid/terminalize` | VTID terminalization |
| `governance.ts` | `/api/v1/governance` | Governance rules |
| `governance-controls.ts` | `/api/v1/governance/controls` | Governance control panel |
| `approvals.ts` | `/api/v1/approvals` | Approval workflows |

### User Preferences & Profile
| File | Prefix | Purpose |
|------|--------|---------|
| `me.ts` | `/api/v1/me` | Current user profile |
| `user-preferences.ts` | `/api/v1/user-preferences` | User preference management |
| `personalization.ts` | `/api/v1/personalization` | Personalization engine |

### Notifications & Feedback
| File | Prefix | Purpose |
|------|--------|---------|
| `notifications.ts` | `/api/v1/notifications` | Notification endpoints |
| `scheduled-notifications.ts` | `/api/v1/scheduled-notifications` | Scheduled notification management |
| `feedback-correction.ts` | `/api/v1/feedback-correction` | Feedback correction loop |

### Commerce & Payments
| File | Prefix | Purpose |
|------|--------|---------|
| `financial-monetization.ts` | `/api/v1/financial` | Financial/wallet endpoints |
| `stripe-connect-webhook.ts` | `/api/v1/stripe/webhook` | Stripe webhook handler |
| `offers.ts` | `/api/v1/offers` | Offer management |
| `creators.ts` | `/api/v1/creators` | Creator economy |

### Automation & Workers
| File | Prefix | Purpose |
|------|--------|---------|
| `automations.ts` | `/api/v1/automations` | Automation rules |
| `execute.ts` | `/api/v1/execute` | Task execution |
| `worker-orchestrator.ts` | `/api/v1/worker` | Worker task orchestration (416KB — very large) |
| `agents-registry.ts` | `/api/v1/agents` | AI agent registry |

### Context Dimensions (d28-d51 series)
| File | Purpose |
|------|---------|
| `emotional-cognitive.ts` | D28 — Emotional/cognitive context |
| `situational-awareness.ts` | D32 — Situational awareness |
| `availability-readiness.ts` | D33 — User availability |
| `environmental-mobility-context.ts` | D34 — Environmental context |
| `social-context.ts` | D35 — Social context |
| `life-stage-awareness.ts` | D40 — Life stage |
| `boundary-consent.ts` | D41 — Boundary/consent |
| `longitudinal-adaptation.ts` | D43 — Longitudinal adaptation |
| `signal-detection.ts` | D44 — Signal detection |
| `predictive-forecasting.ts` | D45 — Predictive risk forecasting |
| `social-alignment.ts` | D47 — Social alignment |
| `opportunity-surfacing.ts` | D48 — Opportunity surfacing |
| `risk-mitigation.ts` | D49 — Risk mitigation |
| `positive-trajectory-reinforcement.ts` | D50 — Positive trajectory |
| `overload-detection.ts` | D51 — Overload detection |
| `taste-alignment.ts` | Taste alignment |
| `visual-interactive.ts` | Visual/interactive context |

### Infrastructure
| File | Prefix | Purpose |
|------|--------|---------|
| `gateway-events-api.ts` | `/api/v1/gateway/events` | Gateway event API |
| `domain-routing.ts` | `/api/v1/domain-routing` | Domain routing |
| `telemetry.ts` | `/api/v1/telemetry` | Telemetry data |
| `cicd.ts` | `/api/v1/cicd` | CI/CD operations |
| `testing.ts` | `/api/v1/testing` | Testing endpoints |
| `self-healing.ts` | `/api/v1/self-healing` | Self-healing diagnostics (34KB) |
| `webhooks.ts` | `/api/v1/webhooks` | Webhook management |
| `email-intake.ts` | `/api/v1/email-intake` | Email ingestion |
| `locations.ts` | `/api/v1/locations` | Location data |

### Other
| File | Purpose |
|------|---------|
| `devhub.ts` | Dev hub data endpoints |
| `board-adapter.ts` | Board/kanban adapter |

### Backup/Deprecated Files (do not use)
- `commandHub.ts.backup-500` — old backup
- `commandhub.ts.bak` — old backup
- `vtid-fix.patch` — old patch
- `vtid.ts.backup` — old backup
- `commandhub-hotfix.ts` — hotfix (check if still active)

## Patterns

- Routes use Express Router: `const router = express.Router()`
- Auth: `router.use(authMiddleware)` or per-route `authMiddleware`
- Validation: Zod schemas inline or imported
- Response format: `res.json({ data, error, status })`
- SSE endpoints use `res.writeHead(200, { 'Content-Type': 'text/event-stream' })`
- Large route files (orb-live, worker-orchestrator) should probably be split
