/**
 * Worker Orchestrator Service - VTID-01163
 *
 * Routes incoming work orders to specialized domain worker subagents
 * (frontend, backend, memory). Implements deterministic routing based on
 * task_domain field and keyword heuristics.
 *
 * VTID-01175: Integrated with Verification Engine to validate worker output
 * before marking tasks as complete.
 *
 * This service does NOT edit code directly - it only validates, routes,
 * and coordinates execution stages via OASIS events.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { markInProgress as autopilotMarkInProgress } from './autopilot-controller';

// =============================================================================
// VTID-01175: Verification Engine Configuration
// =============================================================================

const VERIFICATION_ENGINE_URL = process.env.VERIFICATION_ENGINE_URL ||
  'https://vitana-verification-engine-q74ibpv6ia-uc.a.run.app';

const VERIFICATION_TIMEOUT_MS = parseInt(process.env.VERIFICATION_TIMEOUT_MS || '30000', 10);
const MAX_VERIFICATION_RETRIES = parseInt(process.env.MAX_VERIFICATION_RETRIES || '2', 10);

// =============================================================================
// VTID-01167 + VTID-01170: Identity Defaults (Canonical Identity Enforcement)
// =============================================================================
// Claude must NEVER ask "which project/repo is this?" - these are derived from environment.
//
// VTID-01170 ENFORCEMENT:
// Every VTID MUST have canonical identity injected. If identity is missing:
// - Gateway injects these defaults automatically
// - Agents MUST NOT ask the user for identity values
// =============================================================================

/**
 * Get tenant from environment.
 * For Dev Sandbox: defaults to 'vitana'
 * For multi-tenancy (Maxina/Earthlings/AlKalma): derived from VITANA_TENANT env var
 */
function deriveTenant(): string {
  return process.env.VITANA_TENANT || 'vitana';
}

/**
 * Identity context for the current environment.
 * Infrastructure values are fixed; tenant/environment are derived from context.
 * Claude NEVER asks for these - they are always available.
 */
export const IDENTITY_DEFAULTS = {
  // Infrastructure identifiers - fixed for this deployment
  repo: 'vitana-platform',
  project: process.env.GCP_PROJECT || 'lovable-vitana-vers1',
  region: process.env.GCP_REGION || 'us-central1',
  // Environment and tenant - derived from environment variables
  environment: process.env.VITANA_ENVIRONMENT || 'vitana_dev_sandbox',
  tenant: deriveTenant(),
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Task domains for routing
 * VTID-01207: Added 'infra' and 'ai' domains for specialized workers
 */
export type TaskDomain = 'frontend' | 'backend' | 'memory' | 'infra' | 'ai' | 'mixed';

/**
 * Worker subagent identifiers
 * VTID-01207: Added worker-infra and worker-ai
 */
export type WorkerSubagent = 'worker-frontend' | 'worker-backend' | 'worker-memory' | 'worker-infra' | 'worker-ai';

/**
 * Change budget limits
 */
export interface ChangeBudget {
  max_files?: number;
  max_directories?: number;
}

/**
 * Work order payload for routing
 */
export interface WorkOrderPayload {
  vtid: string;
  title: string;
  task_family?: string;
  task_domain?: TaskDomain;
  target_paths?: string[];
  change_budget?: ChangeBudget;
  spec_content?: string;
  run_id?: string;
}

/**
 * Routing result - always includes identity context
 */
export interface RoutingResult {
  ok: boolean;
  dispatched_to?: WorkerSubagent;
  run_id?: string;
  stages?: Array<{ domain: TaskDomain; order: number }>;
  error?: string;
  error_code?: string;
  // VTID-01167: Identity context injected into every routing result
  identity: typeof IDENTITY_DEFAULTS;
}

/**
 * Subagent execution result
 */
export interface SubagentResult {
  ok: boolean;
  files_changed?: string[];
  files_created?: string[];
  summary?: string;
  error?: string;
  violations?: string[];
}

// =============================================================================
// VTID-01175: Verification Types
// =============================================================================

/**
 * File change claimed by a worker
 */
interface FileChange {
  file_path: string;
  action: 'created' | 'modified' | 'deleted';
}

/**
 * Request payload for verification engine
 */
interface VerifyRequest {
  vtid: string;
  domain: TaskDomain;
  claimed_changes: FileChange[];
  claimed_output?: string;
  started_at?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Response from verification engine
 */
interface VerifyResponse {
  passed: boolean;
  verification_result: string;
  reason: string;
  checks_run: string[];
  checks_passed: string[];
  checks_failed: string[];
  duration_ms: number;
  oasis_event_id?: string;
  recommended_action: 'complete' | 'retry' | 'fail' | 'manual_review';
  details: Record<string, unknown>;
}

/**
 * Result of verification with retry support
 */
export interface VerificationOutcome {
  passed: boolean;
  should_retry: boolean;
  reason: string;
  verification_response?: VerifyResponse;
}

// =============================================================================
// Domain Detection Keywords
// VTID-01206: Comprehensive keyword mapping for Vitana platform
// Based on actual platform inventory: 8 intelligence domains, 23+ engines (D20-D51),
// 87 screens, 71+ API routes, 3 tenants (Maxina, AlKalma, Earthlings)
// =============================================================================

const FRONTEND_KEYWORDS = [
  // Core Web Technologies
  'HTML', 'CSS', 'JavaScript', 'TypeScript', 'React', 'DOM', 'JSX', 'TSX',
  // UI Components
  'button', 'modal', 'form', 'input', 'dropdown', 'select', 'checkbox', 'radio',
  'textarea', 'slider', 'toggle', 'switch', 'card', 'table', 'list', 'grid',
  // Layout & Structure
  'layout', 'flex', 'flexbox', 'responsive', 'mobile', 'desktop', 'tablet',
  'breakpoint', 'container', 'wrapper', 'section', 'div', 'span',
  // Styling & Theming
  'color', 'theme', 'dark mode', 'light mode', 'font', 'typography', 'spacing',
  'margin', 'padding', 'border', 'shadow', 'gradient', 'tailwind', 'styled',
  // Navigation & Routing (87 screens)
  'sidebar', 'navbar', 'menu', 'navigation', 'nav', 'breadcrumb', 'tab', 'link',
  'header', 'footer', 'toolbar', 'panel', 'drawer', 'popover', 'tooltip',
  // User Roles (6 roles)
  'community', 'admin', 'patient', 'staff', 'professional', 'solutions', 'dev', 'system',
  // Visual Elements
  'icon', 'image', 'avatar', 'logo', 'banner', 'carousel', 'gallery',
  'chart', 'graph', 'visualization', 'diagram', 'progress', 'spinner', 'loader',
  // Accessibility
  'WCAG', 'aria', 'a11y', 'accessibility', 'screen reader', 'keyboard',
  // User Interaction
  'click', 'hover', 'focus', 'blur', 'scroll', 'drag', 'drop', 'touch', 'gesture',
  // State & Data Binding
  'useState', 'redux', 'context', 'store', 'state', 'props', 'binding',
  // Animation & Transitions
  'animation', 'transition', 'keyframe', 'motion', 'fade', 'slide',
  // Voice & Speech UI
  'voice', 'voice ui', 'speech bubble', 'transcript', 'waveform', 'audio player',
  'microphone', 'speaker', 'voice input', 'voice output',
  // Health & Longevity UI
  'vitana index', 'health score', 'longevity', 'biomarker chart', 'sleep chart',
  'nutrition tracker', 'fitness display', 'mental health', 'wellness',
  // Matchmaking & Social UI
  'match card', 'profile card', 'compatibility', 'connection', 'relationship',
  'group card', 'event card', 'live room', 'meetup',
  // Commerce & Wallet UI
  'wallet', 'credits', 'balance', 'checkout', 'cart', 'payment', 'pricing',
  'marketplace', 'product card', 'service card', 'order',
  // Messenger & Sharing UI
  'messenger', 'chat bubble', 'message list', 'sharing', 'share button',
  'social share', 'invite', 'notification',
  // Discovery & Shopping UI
  'discover', 'browse', 'search results', 'filter', 'sort', 'category',
  'shopping', 'catalog', 'wishlist', 'favorites',
  // Diary & Reflection UI
  'diary', 'journal', 'entry', 'reflection', 'gratitude', 'mood',
  // Tenant-specific UI
  'Maxina', 'AlKalma', 'Earthlings', 'boat', 'retreat', 'clinic',
  // Vitana UI Specifics
  'Command Hub', 'orb', 'overlay', 'toast', 'notification', 'alert',
  'SPA', 'CSP', 'frontend', 'UI', 'UX', 'interface', 'screen', 'view', 'page',
  'dashboard', 'widget', 'component', 'template', 'render', 'display'
];

/**
 * VTID-01207: AI Domain Keywords
 * For worker-ai: LLM, TTS/STT, multimodal, agents, intelligence engines
 */
const AI_KEYWORDS = [
  // AI & LLM Providers
  'Gemini', 'Claude', 'Anthropic', 'OpenAI', 'GPT', 'Vertex AI', 'Azure AI',
  'Bedrock', 'Mistral', 'Llama', 'Cohere', 'AI21', 'Hugging Face', 'Replicate',
  // AI Core Concepts
  'LLM', 'prompt', 'completion', 'context window', 'temperature',
  'top_p', 'top_k', 'max_tokens', 'system prompt', 'user prompt', 'assistant message',
  'prompt engineering', 'prompt template', 'few-shot', 'zero-shot', 'chain-of-thought',
  // Voice & Speech Processing (TTS/STT)
  'TTS', 'STT', 'text to speech', 'speech to text', 'transcription',
  'voice recognition', 'speech synthesis', 'audio processing', 'voice cloning',
  'whisper', 'elevenlabs', 'google speech', 'azure speech', 'deepgram',
  'voice model', 'voice engine', 'speech engine',
  // Multimodal & Vision
  'multimodal', 'vision', 'image recognition', 'image analysis', 'OCR',
  'document parsing', 'visual understanding', 'image generation', 'DALL-E',
  'stable diffusion', 'midjourney', 'image embedding',
  // AI/ML Concepts
  'inference', 'fine-tune', 'fine-tuning', 'training', 'neural', 'NLP', 'ML',
  'deep learning', 'machine learning', 'transformer', 'attention mechanism',
  'embedding', 'vector embedding', 'semantic', 'cosine similarity',
  // AI Tools & Capabilities
  'function calling', 'tool use', 'structured output', 'JSON mode', 'streaming response',
  'chain of thought', 'reasoning', 'planning', 'reflection', 'self-correction',
  // Agents & Orchestration
  'agent', 'CrewAI', 'multi-agent', 'autonomous agent', 'orchestration', 'subagent',
  'planner agent', 'executor agent', 'verifier agent', 'coordinator', 'dispatcher',
  'agent framework', 'LangChain', 'LlamaIndex', 'AutoGPT', 'agent loop',
  // Automation & Autonomy
  'automation', 'autonomy', 'autopilot', 'autonomous mode', 'auto-pilot',
  'scheduled task', 'background job', 'cron', 'trigger', 'batch processing',
  // Intelligence Engines (D20-D51)
  'intent detection', 'domain routing', 'context assembly',
  'situational awareness', 'emotional cognitive', 'availability readiness',
  'environmental mobility', 'social context', 'financial sensitivity',
  'health capacity', 'taste alignment', 'life stage', 'boundary consent',
  'longitudinal adaptation', 'signal detection', 'opportunity forecasting',
  'anticipatory guidance', 'social alignment', 'opportunity surfacing',
  'risk mitigation', 'trajectory reinforcement', 'overload detection',
  'contextual intelligence', 'predictive intelligence', 'proactive intelligence',
  // Skills & AI Capabilities
  'skill', 'capability', 'skill chain', 'preflight skill', 'skill registry',
  'tool registry', 'skill execution', 'AI skill',
  // Matchmaking & Recommendation AI
  'matchmaking', 'match algorithm', 'compatibility score', 'recommendation engine',
  'people matching', 'group matching', 'event matching', 'service matching',
  'collaborative filtering', 'content-based filtering', 'hybrid recommendation',
  // Health & Longevity AI Processing
  'wearable integration', 'lab report parsing', 'biomarker processing',
  'health compute', 'longevity signal', 'daily recompute', 'health AI',
  'predictive health', 'health scoring',
  // AI-specific Vitana terms
  'ORB', 'orb intelligence', 'vitana ai', 'ai processing', 'ai engine'
];

/**
 * VTID-01207: Infrastructure Domain Keywords
 * For worker-infra: CI/CD, DevOps, deployment, governance, monitoring
 */
const INFRA_KEYWORDS = [
  // CI/CD & Build
  'CI', 'CD', 'CICD', 'CI/CD', 'continuous integration', 'continuous deployment',
  'pipeline', 'build', 'build pipeline', 'release', 'release pipeline',
  'GitHub Actions', 'Cloud Build', 'Jenkins', 'CircleCI', 'GitLab CI',
  'artifact', 'artifact registry', 'npm publish', 'docker build',
  // Deployment & Infrastructure
  'deploy', 'deployment', 'rollback', 'rollout', 'canary', 'blue-green',
  'docker', 'container', 'Dockerfile', 'docker-compose', 'containerization',
  'kubernetes', 'k8s', 'helm', 'pod', 'deployment.yaml', 'service.yaml',
  'GCP', 'Google Cloud', 'cloud run', 'cloud function', 'cloud scheduler',
  'AWS', 'Lambda', 'ECS', 'Azure', 'Azure Functions',
  'Terraform', 'Pulumi', 'CloudFormation', 'infrastructure as code', 'IaC',
  // Configuration & Secrets
  'secrets', 'secret manager', 'environment variable', 'env var', 'config',
  'configuration', '.env', 'config.yaml', 'settings', 'feature flag',
  // Networking & Security Infrastructure
  'VPC', 'network', 'firewall', 'load balancer', 'CDN', 'DNS', 'SSL', 'TLS',
  'IAM', 'service account', 'role', 'permission', 'RBAC',
  'ingress', 'egress', 'proxy', 'reverse proxy', 'nginx', 'traefik',
  // Governance & Compliance
  'governance', 'rule', 'policy', 'compliance', 'audit', 'audit log',
  'access control', 'RLS', 'row level security', 'tenant isolation',
  'security scan', 'vulnerability', 'CVE', 'OWASP', 'penetration test',
  'SOC2', 'HIPAA', 'GDPR', 'data protection', 'privacy',
  // Monitoring & Observability
  'monitoring', 'metrics', 'alerting', 'alert', 'dashboard',
  'logging', 'log aggregation', 'tracing', 'distributed tracing', 'observability',
  'Prometheus', 'Grafana', 'Datadog', 'New Relic', 'Cloud Monitoring',
  'health check', 'heartbeat', 'latency', 'throughput', 'error rate',
  'SLA', 'SLO', 'SLI', 'uptime', 'availability', 'reliability',
  'APM', 'application performance', 'performance monitoring',
  // DevOps & Operations
  'DevOps', 'SRE', 'site reliability', 'incident', 'incident response',
  'on-call', 'runbook', 'playbook', 'disaster recovery', 'backup',
  'scaling', 'auto-scaling', 'horizontal scaling', 'vertical scaling',
  'cost optimization', 'FinOps', 'cloud cost',
  // Version Control & Git
  'git', 'branch', 'merge', 'pull request', 'PR', 'code review',
  'commit', 'tag', 'release tag', 'version', 'semver',
  // Vitana Infrastructure Specifics
  'worker-runner', 'gateway deployment', 'service mesh', 'microservice'
];

/**
 * Backend Domain Keywords (API, business logic, commerce)
 * VTID-01207: Trimmed to exclude AI and infra keywords now handled by dedicated workers
 */
const BACKEND_KEYWORDS = [
  // API & Backend Core
  'endpoint', 'API', 'REST', 'GraphQL', 'POST', 'GET', 'PUT', 'PATCH', 'DELETE',
  'middleware', 'router', 'handler', 'controller', 'service', 'route',
  'request', 'response', 'authentication', 'authorization', 'JWT', 'OAuth',
  'CORS', 'rate limit', 'throttle', 'validation', 'sanitization',
  // Commerce & Token Logic
  'credits', 'VTN', 'token', 'wallet logic', 'transaction processing',
  'payment gateway', 'stripe', 'billing', 'subscription', 'staking',
  'checkout', 'order processing', 'invoice', 'refund', 'pricing logic',
  // Business Logic
  'business rule', 'domain logic', 'use case', 'workflow logic',
  'state machine', 'event handler', 'command handler', 'query handler',
  // Integration & External Services
  'webhook', 'callback', 'integration', 'third-party', 'external API',
  'OAuth provider', 'SSO', 'SAML', 'identity provider',
  // Data Processing
  'data transform', 'ETL', 'data pipeline', 'batch job', 'queue',
  'message queue', 'pub/sub', 'event bus', 'async processing',
  // Vitana Backend Specifics
  'gateway', 'operator', 'worker', 'orchestrator', 'terminalize', 'dispatch',
  'SSE', 'websocket', 'express', 'node', 'backend', 'server',
  'OASIS API', 'VTID API', 'ledger API'
];

const MEMORY_KEYWORDS = [
  // Database Core
  'database', 'DB', 'supabase', 'postgres', 'PostgreSQL', 'SQL', 'NoSQL',
  'table', 'schema', 'migration', 'query', 'index', 'constraint',
  'insert', 'update', 'delete', 'select', 'join', 'transaction',
  'foreign key', 'primary key', 'trigger', 'function', 'stored procedure',
  // OASIS & Event System
  'OASIS', 'ledger', 'vtid_ledger', 'oasis_events', 'oasis_specs',
  'event', 'event sourcing', 'projection', 'state machine', 'lifecycle',
  'vtid', 'task state', 'terminal', 'status transition',
  // Vector & Embeddings
  'vector', 'embedding', 'qdrant', 'pgvector', 'similarity', 'cosine',
  'semantic search', 'RAG', 'retrieval', 'nearest neighbor', 'ANN',
  // Knowledge Base
  'knowledge base', 'document', 'chunking', 'indexing', 'corpus',
  'mem0', 'memory store', 'long-term memory', 'short-term memory',
  // Health & Longevity Data (Vitana Index - 5 Pillars)
  'biomarker', 'biomarkers', 'lab result', 'wearable data', 'health data',
  'physical health', 'mental health', 'nutritional health', 'social health', 'environmental health',
  'sleep data', 'nutrition data', 'fitness data', 'stress data', 'hydration',
  'vitana index', 'longevity score', 'health score',
  // Relationship & Social Data
  'relationship graph', 'relationship data', 'match history', 'compatibility data',
  'connection data', 'social graph', 'community data', 'group membership',
  'event attendance', 'live room history',
  // Diary & Reflection Data
  'diary entry', 'journal data', 'reflection data', 'gratitude log',
  'mood history', 'habit data', 'values', 'meaning',
  // Commerce & Wallet Data
  'wallet data', 'credit balance', 'transaction history', 'order history',
  'purchase data', 'subscription data', 'payment history',
  'product catalog', 'services catalog', 'offers data',
  // Tenant Data (Maxina, AlKalma, Earthlings)
  'Maxina data', 'AlKalma data', 'Earthlings data', 'tenant data',
  'care program', 'retreat booking', 'telemedicine',
  // Contextual Intelligence (D44, D48, D49)
  'context', 'user context', 'tenant', 'personalization', 'recommendation',
  'D44', 'D48', 'D49', 'predictive signal', 'opportunity', 'risk signal',
  'intelligence', 'insight', 'pattern', 'proactive', 'anticipation',
  // Analytics & Metrics Data
  'analytics', 'metrics', 'telemetry', 'tracking', 'measurement',
  'data warehouse', 'aggregation', 'time series', 'historical',
  'reporting', 'statistics', 'KPI', 'dashboard data',
  // User & Profile Data
  'user data', 'profile', 'preferences', 'settings', 'constraints',
  'session', 'cache', 'storage', 'persistence', 'data model',
  // Vitana Memory Specifics
  'memory', 'context retrieval', 'memory injection', 'recall',
  'memory governance', 'memory visibility', 'memory export'
];

// =============================================================================
// Path Patterns for Domain Detection
// =============================================================================

const FRONTEND_PATH_PATTERNS = [
  /services\/gateway\/src\/frontend\//,
  /services\/gateway\/dist\/frontend\//,
  /\.html$/,
  /\.css$/,
  /\/frontend\//,
  /\/web\//
];

const BACKEND_PATH_PATTERNS = [
  /services\/gateway\/src\/routes\//,
  /services\/gateway\/src\/controllers\//,
  /services\/.*\/src\/routes\//,
  /services\/.*\/src\/controllers\//,
  /\/routes\//,
  /\/controllers\//,
  /\/middleware\//
];

/**
 * VTID-01207: Infrastructure path patterns for worker-infra
 */
const INFRA_PATH_PATTERNS = [
  /\.github\/workflows\//,
  /\.github\/actions\//,
  /scripts\/deploy\//,
  /scripts\/ci\//,
  /scripts\/infra\//,
  /scripts\//,
  /Dockerfile/,
  /docker-compose/,
  /\.dockerfile$/,
  /cloudbuild\.yaml$/,
  /terraform\//,
  /pulumi\//,
  /k8s\//,
  /kubernetes\//,
  /helm\//,
  /\.tf$/,
  /Makefile/,
  /\.sh$/
];

/**
 * VTID-01207: AI/Agent path patterns for worker-ai
 */
const AI_PATH_PATTERNS = [
  /services\/agents\//,
  /services\/gateway\/src\/services\/.*-intelligence/,
  /services\/gateway\/src\/services\/orb/,
  /services\/gateway\/src\/services\/ai/,
  /services\/gateway\/src\/services\/skills/,
  /\/agents\//,
  /\/intelligence\//,
  /\/ai\//,
  /\/llm\//,
  /\/prompts\//,
  /\.prompt\.md$/
];

const MEMORY_PATH_PATTERNS = [
  /supabase\/migrations\//,
  /services\/agents\/memory-indexer\//,
  /\/memory\//,
  /\.sql$/,
  // VTID-01206: Added OASIS/database patterns
  /DATABASE_SCHEMA\.md/
];

// =============================================================================
// Default Change Budgets
// =============================================================================

/**
 * VTID-01207: Updated to include infra and ai domain budgets
 */
const DEFAULT_BUDGETS: Record<TaskDomain, ChangeBudget> = {
  frontend: { max_files: 10, max_directories: 5 },
  backend: { max_files: 15, max_directories: 8 },
  memory: { max_files: 5, max_directories: 3 },
  infra: { max_files: 10, max_directories: 6 },
  ai: { max_files: 12, max_directories: 5 },
  mixed: { max_files: 20, max_directories: 10 }
};

// =============================================================================
// OASIS Event Helpers
// =============================================================================

/**
 * Emit orchestrator stage event
 */
async function emitOrchestratorEvent(
  vtid: string,
  stage: 'start' | 'route' | 'success' | 'failed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.worker_orchestrator.${stage}` as any,
    source: 'worker-orchestrator',
    status,
    message,
    payload: {
      vtid,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

/**
 * Emit subagent stage event
 */
async function emitSubagentEvent(
  vtid: string,
  domain: TaskDomain,
  stage: 'start' | 'success' | 'failed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.worker_${domain}.${stage}` as any,
    source: `worker-${domain}`,
    status,
    message,
    payload: {
      vtid,
      domain,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

// =============================================================================
// Domain Detection Logic
// =============================================================================

/**
 * Detect domain from keywords in title/spec
 * VTID-01207: Added infra and ai domain detection
 */
function detectDomainFromKeywords(text: string): TaskDomain[] {
  const normalizedText = text.toLowerCase();
  const domains: TaskDomain[] = [];

  // Check frontend keywords
  if (FRONTEND_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('frontend');
  }

  // Check AI keywords (VTID-01207)
  if (AI_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('ai');
  }

  // Check infra keywords (VTID-01207)
  if (INFRA_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('infra');
  }

  // Check backend keywords
  if (BACKEND_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('backend');
  }

  // Check memory keywords
  if (MEMORY_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('memory');
  }

  return domains;
}

/**
 * Detect domain from target paths
 * VTID-01207: Added infra and ai path detection
 */
function detectDomainFromPaths(paths: string[]): TaskDomain[] {
  const domains: TaskDomain[] = [];

  for (const path of paths) {
    // Check frontend paths
    if (FRONTEND_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('frontend')) domains.push('frontend');
    }

    // Check AI paths (VTID-01207) - agents, intelligence, skills
    if (AI_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('ai')) domains.push('ai');
    }

    // Check infra paths (VTID-01207) - CI/CD, deploy scripts, Docker
    if (INFRA_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('infra')) domains.push('infra');
    }

    // Check backend paths (excluding frontend, infra, and ai paths)
    if (BACKEND_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      const isFrontend = FRONTEND_PATH_PATTERNS.some(p => p.test(path));
      const isInfra = INFRA_PATH_PATTERNS.some(p => p.test(path));
      const isAi = AI_PATH_PATTERNS.some(p => p.test(path));
      if (!isFrontend && !isInfra && !isAi) {
        if (!domains.includes('backend')) domains.push('backend');
      }
    }

    // Check memory paths
    if (MEMORY_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('memory')) domains.push('memory');
    }
  }

  return domains;
}

/**
 * Infer task domain from payload
 */
function inferTaskDomain(payload: WorkOrderPayload): TaskDomain {
  const detectedDomains: TaskDomain[] = [];

  // Check target_paths first (most explicit)
  if (payload.target_paths && payload.target_paths.length > 0) {
    detectedDomains.push(...detectDomainFromPaths(payload.target_paths));
  }

  // Check title keywords
  if (payload.title) {
    detectedDomains.push(...detectDomainFromKeywords(payload.title));
  }

  // Check spec content if available
  if (payload.spec_content) {
    detectedDomains.push(...detectDomainFromKeywords(payload.spec_content));
  }

  // Deduplicate
  const uniqueDomains = [...new Set(detectedDomains)];

  // Determine final domain
  if (uniqueDomains.length === 0) {
    // Default to backend if no domain detected (most common case)
    return 'backend';
  } else if (uniqueDomains.length === 1) {
    return uniqueDomains[0];
  } else {
    return 'mixed';
  }
}

/**
 * Get subagent ID for domain
 * VTID-01207: Added worker-infra and worker-ai routing
 */
function getSubagentForDomain(domain: TaskDomain): WorkerSubagent | null {
  switch (domain) {
    case 'frontend':
      return 'worker-frontend';
    case 'backend':
      return 'worker-backend';
    case 'memory':
      return 'worker-memory';
    case 'infra':
      return 'worker-infra';
    case 'ai':
      return 'worker-ai';
    case 'mixed':
      return null; // Mixed requires splitting
    default:
      return null;
  }
}

// =============================================================================
// Path Validation
// =============================================================================

/**
 * Validate that target paths are allowed for a domain
 */
/**
 * VTID-01207: Updated to handle infra and ai domains
 */
function validatePathsForDomain(
  domain: TaskDomain,
  paths: string[]
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (domain === 'mixed') {
    // Mixed domain doesn't have specific path restrictions
    return { valid: true, violations: [] };
  }

  for (const path of paths) {
    let isValid = false;

    switch (domain) {
      case 'frontend':
        isValid = FRONTEND_PATH_PATTERNS.some(pattern => pattern.test(path));
        // Also check it's not a forbidden backend path
        if (isValid && /\/routes\/|\/services\/|\/middleware\//.test(path)) {
          isValid = false;
        }
        break;

      case 'backend':
        isValid = BACKEND_PATH_PATTERNS.some(pattern => pattern.test(path));
        // Exclude frontend paths
        if (isValid && FRONTEND_PATH_PATTERNS.some(p => p.test(path))) {
          isValid = false;
        }
        // Exclude memory paths
        if (isValid && MEMORY_PATH_PATTERNS.some(p => p.test(path))) {
          isValid = false;
        }
        break;

      case 'memory':
        isValid = MEMORY_PATH_PATTERNS.some(pattern => pattern.test(path));
        break;

      case 'infra':
        isValid = INFRA_PATH_PATTERNS.some(pattern => pattern.test(path));
        break;

      case 'ai':
        isValid = AI_PATH_PATTERNS.some(pattern => pattern.test(path));
        break;
    }

    if (!isValid) {
      violations.push(`Path "${path}" is not allowed for domain "${domain}"`);
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

// =============================================================================
// Payload Validation
// =============================================================================

const VTID_PATTERN = /^VTID-\d{4,}$/;

/**
 * Validate work order payload
 */
function validatePayload(payload: WorkOrderPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!payload.vtid) {
    errors.push('vtid is required');
  } else if (!VTID_PATTERN.test(payload.vtid)) {
    errors.push('vtid must match pattern VTID-XXXXX');
  }

  if (!payload.title || payload.title.trim() === '') {
    errors.push('title is required and must be non-empty');
  }

  // Validate task_domain if provided
  // VTID-01207: Added infra and ai to valid domains
  if (payload.task_domain) {
    const validDomains: TaskDomain[] = ['frontend', 'backend', 'memory', 'infra', 'ai', 'mixed'];
    if (!validDomains.includes(payload.task_domain)) {
      errors.push(`task_domain must be one of: ${validDomains.join(', ')}`);
    }
  }

  // Validate change_budget if provided
  if (payload.change_budget) {
    if (payload.change_budget.max_files !== undefined && payload.change_budget.max_files < 1) {
      errors.push('change_budget.max_files must be at least 1');
    }
    if (payload.change_budget.max_directories !== undefined && payload.change_budget.max_directories < 1) {
      errors.push('change_budget.max_directories must be at least 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// =============================================================================
// Main Routing Function
// =============================================================================

/**
 * Route work order to appropriate subagent
 *
 * This is the main entry point for the orchestrator. It:
 * 1. Validates the payload
 * 2. Determines the target domain
 * 3. Validates paths for the domain
 * 4. Emits routing events
 * 5. Returns routing result (does NOT execute the work)
 */
export async function routeWorkOrder(payload: WorkOrderPayload): Promise<RoutingResult> {
  const run_id = payload.run_id || `route_${randomUUID().slice(0, 8)}`;
  const vtid = payload.vtid || 'UNKNOWN';

  console.log(`[VTID-01163] Routing work order: ${vtid} (run_id=${run_id})`);

  // Step 1: Emit orchestrator start event
  await emitOrchestratorEvent(vtid, 'start', 'info', `Orchestrator started for ${vtid}`, {
    run_id,
    title: payload.title
  });

  try {
    // Step 2: Validate payload
    const validation = validatePayload(payload);
    if (!validation.valid) {
      const errorMsg = `Validation failed: ${validation.errors.join('; ')}`;
      console.error(`[VTID-01163] ${errorMsg}`);
      await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
        run_id,
        error_code: 'VALIDATION_FAILED',
        errors: validation.errors
      });
      return {
        ok: false,
        error: errorMsg,
        error_code: 'VALIDATION_FAILED',
        run_id,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 3: Determine task domain
    let domain: TaskDomain;
    if (payload.task_domain) {
      domain = payload.task_domain;
    } else {
      domain = inferTaskDomain(payload);
      console.log(`[VTID-01163] Inferred domain: ${domain} for ${vtid}`);
    }

    // Step 4: Validate paths for domain
    if (payload.target_paths && payload.target_paths.length > 0) {
      const pathValidation = validatePathsForDomain(domain, payload.target_paths);
      if (!pathValidation.valid) {
        const errorMsg = `Path validation failed: ${pathValidation.violations.join('; ')}`;
        console.error(`[VTID-01163] ${errorMsg}`);
        await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
          run_id,
          error_code: 'PATH_FORBIDDEN',
          violations: pathValidation.violations
        });
        return {
          ok: false,
          error: errorMsg,
          error_code: 'PATH_FORBIDDEN',
          run_id,
          identity: IDENTITY_DEFAULTS
        };
      }
    }

    // Step 5: Handle mixed domain (split into stages)
    if (domain === 'mixed') {
      const detectedDomains = [...new Set([
        ...detectDomainFromPaths(payload.target_paths || []),
        ...detectDomainFromKeywords(payload.title),
        ...detectDomainFromKeywords(payload.spec_content || '')
      ])];

      // Order: memory -> backend -> frontend
      const orderedDomains: TaskDomain[] = [];
      if (detectedDomains.includes('memory')) orderedDomains.push('memory');
      if (detectedDomains.includes('backend')) orderedDomains.push('backend');
      if (detectedDomains.includes('frontend')) orderedDomains.push('frontend');

      const stages = orderedDomains.map((d, i) => ({ domain: d, order: i + 1 }));

      await emitOrchestratorEvent(vtid, 'route', 'info', `Mixed task split into ${stages.length} stages`, {
        run_id,
        domain: 'mixed',
        stages
      });

      console.log(`[VTID-01163] Mixed task ${vtid} split into stages:`, stages);

      return {
        ok: true,
        run_id,
        stages,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 6: Route to single subagent
    const subagent = getSubagentForDomain(domain);
    if (!subagent) {
      const errorMsg = `No subagent available for domain: ${domain}`;
      console.error(`[VTID-01163] ${errorMsg}`);
      await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
        run_id,
        error_code: 'SUBAGENT_UNAVAILABLE',
        domain
      });
      return {
        ok: false,
        error: errorMsg,
        error_code: 'SUBAGENT_UNAVAILABLE',
        run_id,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 7: Emit routing event
    await emitOrchestratorEvent(vtid, 'route', 'info', `Routing to ${subagent}`, {
      run_id,
      domain,
      dispatched_to: subagent,
      target_paths: payload.target_paths,
      change_budget: payload.change_budget || DEFAULT_BUDGETS[domain]
    });

    console.log(`[VTID-01163] Routed ${vtid} to ${subagent}`);

    // VTID-01178: Mandatory IN_PROGRESS trigger when worker job dispatched
    // This updates vtid_ledger.status = 'in_progress' and emits autopilot state event
    try {
      await autopilotMarkInProgress(vtid, run_id);
      console.log(`[VTID-01163] Marked ${vtid} as in_progress (autopilot controller)`);
    } catch (err) {
      // Non-fatal: log but don't block routing
      console.warn(`[VTID-01163] Failed to mark ${vtid} as in_progress:`, err);
    }

    return {
      ok: true,
      dispatched_to: subagent,
      run_id,
      identity: IDENTITY_DEFAULTS
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown routing error';
    console.error(`[VTID-01163] Routing error for ${vtid}:`, errorMsg);

    await emitOrchestratorEvent(vtid, 'failed', 'error', `Routing failed: ${errorMsg}`, {
      run_id,
      error_code: 'ROUTING_ERROR',
      error: errorMsg
    });

    return {
      ok: false,
      error: errorMsg,
      error_code: 'ROUTING_ERROR',
      run_id,
      identity: IDENTITY_DEFAULTS
    };
  }
}

/**
 * Mark orchestrator success after all subagents complete
 */
export async function markOrchestratorSuccess(
  vtid: string,
  run_id: string,
  summary: string
): Promise<void> {
  await emitOrchestratorEvent(vtid, 'success', 'success', summary, {
    run_id,
    completed_at: new Date().toISOString()
  });
}

/**
 * Mark orchestrator failed
 */
export async function markOrchestratorFailed(
  vtid: string,
  run_id: string,
  error: string
): Promise<void> {
  await emitOrchestratorEvent(vtid, 'failed', 'error', error, {
    run_id,
    failed_at: new Date().toISOString()
  });
}

/**
 * Emit subagent start event (called when subagent begins work)
 */
export async function emitSubagentStart(
  vtid: string,
  domain: TaskDomain,
  run_id: string
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'start',
    'info',
    `Worker ${domain} started for ${vtid}`,
    { run_id }
  );
}

/**
 * Emit subagent success event
 */
export async function emitSubagentSuccess(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  result: SubagentResult
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'success',
    'success',
    result.summary || `Worker ${domain} completed for ${vtid}`,
    {
      run_id,
      files_changed: result.files_changed,
      files_created: result.files_created
    }
  );
}

/**
 * Emit subagent failed event
 */
export async function emitSubagentFailed(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  error: string,
  violations?: string[]
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'failed',
    'error',
    `Worker ${domain} failed: ${error}`,
    {
      run_id,
      error,
      violations
    }
  );
}

// =============================================================================
// VTID-01175: Verification Engine Integration
// =============================================================================

/**
 * Emit verification stage event
 */
async function emitVerificationEvent(
  vtid: string,
  stage: 'start' | 'passed' | 'failed' | 'error',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.verification.${stage}` as any,
    source: 'worker-orchestrator',
    status,
    message,
    payload: {
      vtid,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

/**
 * Call the verification engine to validate worker output
 *
 * VTID-01175: This is the integration point between the orchestrator and
 * the verification engine. The verification engine validates that:
 * - Claimed files actually exist
 * - Files were actually modified (not just claimed)
 * - Domain-specific rules are satisfied
 * - No safety violations occurred
 */
export async function verifyWorkerOutput(
  vtid: string,
  domain: TaskDomain,
  result: SubagentResult,
  run_id: string,
  startedAt?: Date
): Promise<VerificationOutcome> {
  console.log(`[VTID-01175] Verifying worker output for ${vtid} (domain=${domain})`);

  // Emit verification start event
  await emitVerificationEvent(vtid, 'start', 'info', `Verification started for ${vtid}`, {
    run_id,
    domain,
    files_count: (result.files_changed?.length || 0) + (result.files_created?.length || 0)
  });

  // Build claimed changes from result
  const claimedChanges: FileChange[] = [
    ...(result.files_changed || []).map(f => ({ file_path: f, action: 'modified' as const })),
    ...(result.files_created || []).map(f => ({ file_path: f, action: 'created' as const }))
  ];

  // If no files claimed, pass verification (nothing to verify)
  if (claimedChanges.length === 0) {
    console.log(`[VTID-01175] No files claimed for ${vtid}, skipping verification`);
    await emitVerificationEvent(vtid, 'passed', 'success', 'No files to verify', {
      run_id,
      domain,
      skipped: true
    });
    return {
      passed: true,
      should_retry: false,
      reason: 'No files to verify'
    };
  }

  const request: VerifyRequest = {
    vtid,
    domain,
    claimed_changes: claimedChanges,
    claimed_output: result.summary || '',
    started_at: startedAt?.toISOString(),
    metadata: {
      run_id,
      files_changed: result.files_changed,
      files_created: result.files_created
    }
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);

    const response = await fetch(`${VERIFICATION_ENGINE_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VTID': vtid,
        'X-Run-ID': run_id
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[VTID-01175] Verification request failed: ${response.status} - ${errorText}`);

      await emitVerificationEvent(vtid, 'error', 'error', `Verification service error: ${response.status}`, {
        run_id,
        domain,
        http_status: response.status,
        error: errorText
      });

      // On service error, recommend manual review
      return {
        passed: false,
        should_retry: false,
        reason: `Verification service error: ${response.status}`
      };
    }

    const verifyResponse = await response.json() as VerifyResponse;

    console.log(`[VTID-01175] Verification result for ${vtid}: ${verifyResponse.passed ? 'PASSED' : 'FAILED'} - ${verifyResponse.reason}`);

    if (verifyResponse.passed) {
      await emitVerificationEvent(vtid, 'passed', 'success', verifyResponse.reason, {
        run_id,
        domain,
        checks_passed: verifyResponse.checks_passed,
        duration_ms: verifyResponse.duration_ms
      });

      return {
        passed: true,
        should_retry: false,
        reason: verifyResponse.reason,
        verification_response: verifyResponse
      };
    } else {
      await emitVerificationEvent(vtid, 'failed', 'warning', verifyResponse.reason, {
        run_id,
        domain,
        checks_failed: verifyResponse.checks_failed,
        recommended_action: verifyResponse.recommended_action,
        duration_ms: verifyResponse.duration_ms,
        details: verifyResponse.details
      });

      return {
        passed: false,
        should_retry: verifyResponse.recommended_action === 'retry',
        reason: verifyResponse.reason,
        verification_response: verifyResponse
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown verification error';
    console.error(`[VTID-01175] Verification error for ${vtid}:`, errorMsg);

    await emitVerificationEvent(vtid, 'error', 'error', `Verification error: ${errorMsg}`, {
      run_id,
      domain,
      error: errorMsg
    });

    // On network/timeout error, allow retry
    return {
      passed: false,
      should_retry: true,
      reason: `Verification error: ${errorMsg}`
    };
  }
}

/**
 * Complete subagent execution with verification
 *
 * VTID-01175: This is the main entry point for completing a subagent task.
 * It verifies worker output before marking success. On verification failure,
 * it returns a result indicating whether to retry.
 *
 * Flow:
 * 1. Call verification engine
 * 2. If passed: emit success event, return success
 * 3. If failed + retriable: return should_retry=true
 * 4. If failed + not retriable: emit failure event, return failure
 */
export async function completeSubagentWithVerification(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  result: SubagentResult,
  startedAt?: Date,
  retryCount: number = 0
): Promise<{
  ok: boolean;
  should_retry: boolean;
  reason: string;
  retry_count: number;
}> {
  console.log(`[VTID-01175] Completing subagent ${domain} for ${vtid} (attempt=${retryCount + 1})`);

  // Step 1: Verify worker output
  const verification = await verifyWorkerOutput(vtid, domain, result, run_id, startedAt);

  // Step 2: Handle verification result
  if (verification.passed) {
    // Verification passed - emit success
    await emitSubagentSuccess(vtid, domain, run_id, result);
    return {
      ok: true,
      should_retry: false,
      reason: verification.reason,
      retry_count: retryCount
    };
  }

  // Step 3: Verification failed
  if (verification.should_retry && retryCount < MAX_VERIFICATION_RETRIES) {
    // Can retry - don't emit failure yet
    console.log(`[VTID-01175] Verification failed for ${vtid}, recommending retry (${retryCount + 1}/${MAX_VERIFICATION_RETRIES})`);
    return {
      ok: false,
      should_retry: true,
      reason: verification.reason,
      retry_count: retryCount
    };
  }

  // Step 4: Cannot retry or max retries exceeded - emit failure
  const failureReason = retryCount >= MAX_VERIFICATION_RETRIES
    ? `Verification failed after ${retryCount + 1} attempts: ${verification.reason}`
    : `Verification failed (not retriable): ${verification.reason}`;

  await emitSubagentFailed(vtid, domain, run_id, failureReason, [verification.reason]);
  return {
    ok: false,
    should_retry: false,
    reason: failureReason,
    retry_count: retryCount
  };
}

/**
 * Complete orchestrator with verification of all subagent results
 *
 * VTID-01175: Verifies all work before marking orchestrator complete.
 * This is called after all subagents have reported completion.
 */
export async function completeOrchestratorWithVerification(
  vtid: string,
  run_id: string,
  domain: TaskDomain,
  result: SubagentResult,
  startedAt?: Date
): Promise<{
  ok: boolean;
  should_retry: boolean;
  reason: string;
}> {
  const completion = await completeSubagentWithVerification(
    vtid,
    domain,
    run_id,
    result,
    startedAt,
    0
  );

  if (completion.ok) {
    // Verification passed - mark orchestrator success
    await markOrchestratorSuccess(vtid, run_id, `Task completed and verified: ${completion.reason}`);
  } else if (!completion.should_retry) {
    // Verification failed and cannot retry - mark orchestrator failed
    await markOrchestratorFailed(vtid, run_id, completion.reason);
  }
  // If should_retry, caller decides whether to retry the worker

  return {
    ok: completion.ok,
    should_retry: completion.should_retry,
    reason: completion.reason
  };
}

// =============================================================================
// Exports for Testing
// =============================================================================

export const _internal = {
  detectDomainFromKeywords,
  detectDomainFromPaths,
  inferTaskDomain,
  validatePathsForDomain,
  validatePayload,
  getSubagentForDomain,
  FRONTEND_KEYWORDS,
  BACKEND_KEYWORDS,
  MEMORY_KEYWORDS,
  // VTID-01207: Added infra and ai keyword exports
  INFRA_KEYWORDS,
  AI_KEYWORDS,
  DEFAULT_BUDGETS,
  // VTID-01175: Verification internals
  VERIFICATION_ENGINE_URL,
  VERIFICATION_TIMEOUT_MS,
  MAX_VERIFICATION_RETRIES
};
