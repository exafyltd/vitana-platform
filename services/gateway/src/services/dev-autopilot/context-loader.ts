/**
 * Autopilot prompt-context loader — VTID-AUTOPILOT-PROMPT
 *
 * Returns the codebase conventions + curated imports surface that gets
 * injected into every Dev Autopilot planner + executor prompt.
 *
 * Why: PR backlog tests showed Gemini 3.1 Pro Preview hallucinating module
 * exports (e.g. `import { supabase } from '../lib/supabase'` — actual export
 * is the `getSupabase()` factory) and ignoring repo file-naming conventions
 * (camelCase filenames trip the `Enforce Phase 2B Naming Standards` CI
 * check). Both are prompt-context gaps, not LLM-quality issues. Inject the
 * rules so the model has them in front of it on every call.
 *
 * Why embedded as TS string constants instead of separate .md files:
 * the gateway's build (`tsc && copy-frontend`) doesn't copy arbitrary
 * non-TS assets to dist by default. Embedding here means the conventions
 * survive `tsc` cleanly with zero build-chain changes.
 *
 * Editing: change the strings below, run `npm run typecheck`, redeploy
 * the gateway. The change is in front of the next planner/executor call.
 */

const LOG_PREFIX = '[dev-autopilot/context-loader]';

const CONVENTIONS = `# Vitana platform — code conventions

## File naming

- All \`.ts\` / \`.tsx\` / \`.js\` / \`.jsx\` files MUST use **kebab-case**.
  - ✅ \`param-limit.ts\`, \`user-routes.ts\`, \`auth-supabase-jwt.ts\`
  - ❌ \`paramLimit.ts\`, \`userRoutes.ts\`, \`auth_supabase_jwt.ts\`
- The CI check \`Enforce Phase 2B Naming Standards\` rejects camelCase and
  snake_case file names. Allowed exceptions: \`README\`, \`LICENSE\`,
  \`CHANGELOG\`, \`Dockerfile\`, \`Makefile\`.
- \`.github/workflows/*.yml\` files MUST use **UPPERCASE-WITH-HYPHENS**.

## Database & API

- **Postgres tables: snake_case** (\`vtid_ledger\`, \`oasis_events\`,
  \`dev_autopilot_executions\`). Never \`VtidLedger\` / \`vtidLedger\`.
- **API routes: \`/api/v1/...\`** with kebab-case path segments
  (\`/api/v1/dev-autopilot/findings\`).
- **Response shape:** \`{ ok: boolean, error?: string, data?: T }\`. JSON
  keys are snake_case.
- **TS imports of \`@supabase/supabase-js\` directly are forbidden** in
  route handlers — use the \`getSupabase()\` factory below.

## VTID format

- VTIDs are \`VTID-XXXXX\` (5-digit zero-padded). Other accepted prefixes:
  \`DEV-COMHU-XXXX-YYYY\`, \`BOOTSTRAP-...\`.
- VTID constants in code: \`const VTID = 'VTID-01234';\` (UPPERCASE name).

## TypeScript style

- Strict mode is on; \`tsc --noEmit\` is a required CI check (\`validate\`).
  Code MUST compile clean before any merge — branch protection enforces it.
- Prefer \`async function\`/\`await\` over \`.then()\` chains.
- Use Zod for incoming-request validation (\`req.body\`, \`req.params\`,
  \`req.query\`).

## Express route pattern

\`\`\`ts
import { Router, Request, Response } from 'express';
import { requireAuth, requireExafyAdmin } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();

router.get('/path', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });
  // ...
  return res.json({ ok: true, data: { /* ... */ } });
});

export default router;
\`\`\`

## Common antipatterns the Dev Autopilot has previously hallucinated

| ❌ Wrong | ✅ Right |
|---|---|
| \`import { supabase } from '../lib/supabase'\` | \`import { getSupabase } from '../lib/supabase';\` then \`const supabase = getSupabase(); if (!supabase) return ...;\` |
| \`import { authMiddleware } from '../middleware/auth'\` | \`import { requireAuth } from '../middleware/auth-supabase-jwt';\` |
| \`import { db } from '../lib/db'\` | \`import { getSupabase } from '../lib/supabase';\` (there is no separate \`db\` module) |
| \`services/agents/voice/*.py\` (Python paths) | This codebase is **TypeScript + Node only**. Python paths are always wrong. |
| \`services/gateway/src/routes/v1/...\` (deep nesting) | Flat under \`services/gateway/src/routes/\`. The \`/api/v1/\` prefix lives at mount time in \`index.ts\`. |
| \`paramLimit.ts\`, \`userRoutes.ts\` (camelCase) | \`param-limit.ts\`, \`user-routes.ts\` (kebab-case) |

## When in doubt

- Check the imports surface section below for actual public exports.
- If a needed export isn't in the surface or in the file you're editing,
  STOP and surface the gap in the PR body — do NOT guess at module APIs.
- Keep the diff minimal. The plan's \`LOCKED FILE LIST\` is hard — never
  emit a file outside it.
`;

const IMPORTS_SURFACE = `# Imports surface — public exports of frequently-imported gateway modules

## \`services/gateway/src/lib/supabase.ts\` (70+ importers)

\`\`\`ts
export const getSupabase: () => SupabaseClient | null;
\`\`\`

Usage:
\`\`\`ts
import { getSupabase } from '../lib/supabase';
const supabase = getSupabase();
if (!supabase) return res.status(503).json({ ok: false, error: 'no supabase' });
\`\`\`

There is **no** bare \`supabase\` named export. There is **no** default export.

## \`services/gateway/src/lib/supabase-user.ts\` (40+ importers)

\`\`\`ts
export function createUserSupabaseClient(userToken: string): SupabaseClient;
\`\`\`

Wraps a Supabase client scoped to a user JWT (RLS-enforcing).

## \`services/gateway/src/middleware/auth-supabase-jwt.ts\` (27+ importers)

\`\`\`ts
export interface SupabaseIdentity {
  user_id: string;
  email: string | null;
  tenant_id: string | null;
  exafy_admin: boolean;
  role: string | null;
}
export interface AuthenticatedRequest extends Request {
  identity?: SupabaseIdentity;
}
export type AuthSource = 'platform' | 'lovable';

export async function verifyAndExtractIdentity(req: Request):
  Promise<{ ok: true; identity: SupabaseIdentity } | { ok: false; status: number; error: string }>;

export const requireAuth: RequestHandler;
export const optionalAuth: RequestHandler;
export const requireExafyAdmin: RequestHandler;
export async function requireTenant(req, res, next): Promise<void>;

export async function resolveVitanaId(userId: string): Promise<string | null>;
export function invalidateVitanaIdCache(userId: string): void;
\`\`\`

Usage in a route:
\`\`\`ts
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.identity!.user_id;
  // ...
});
\`\`\`

## \`services/gateway/src/services/oasis-event-service.ts\` (104+ importers)

\`\`\`ts
export async function emitOasisEvent(event: CicdOasisEvent):
  Promise<{ ok: boolean; event_id?: string; error?: string }>;

export const cicdEvents: { /* helpers per CICD event type */ };
export const memoryGovernanceEvents: { /* helpers */ };
export const responseFramingEvents: { /* helpers */ };

export const GOVERNANCE_EVENT_TYPES: readonly string[];
export const MEMORY_GOVERNANCE_EVENT_TYPES: readonly string[];
export const RESPONSE_FRAMING_EVENT_TYPES: readonly string[];

export interface GovernanceHistoryEvent { /* ... */ }
export async function getGovernanceHistory(params: GovernanceHistoryParams):
  Promise<{ ok: boolean; events?: GovernanceHistoryEvent[]; error?: string }>;
\`\`\`

The event payload type \`CicdOasisEvent\` lives in \`../types/cicd.ts\`. Add
new event types to \`CicdEventType\` (string-literal union) BEFORE emitting
them — \`tsc\` will reject unknown types.

## \`services/gateway/src/services/notification-service.ts\` (13+ importers)

\`\`\`ts
export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function notifyUser(
  userId: string,
  tenantId: string,
  category: string,
  payload: NotificationPayload,
  supabase?: SupabaseClient,
): Promise<void>;

export function notifyUserAsync(/* fire-and-forget variant */): void;
export function notifyUsersAsync(/* batch variant */): void;
export async function sendPushNotification(/* ... */): Promise<void>;
export async function sendPushToUser(/* ... */): Promise<void>;
export async function sendAppilixPush(/* ... */): Promise<void>;
\`\`\`

## \`services/gateway/src/types/cicd.ts\`

Big string-literal union \`CicdEventType\`. Add a new event type here BEFORE
\`emitOasisEvent\` will accept it (\`tsc\` will error otherwise — that's
the spec compliance gate).

\`\`\`ts
export type CicdEventType =
  | 'cicd.github.create_pr.requested'
  | 'cicd.github.safe_merge.executed'
  | 'dev_autopilot.execution.approved'
  | 'dev_autopilot.execution.bridged'
  | 'vtid.lifecycle.completed'
  | 'vtid.lifecycle.failed'
  // ...many more — see the full file before adding
  ;
\`\`\`

## How to use this section

When you need to import from a module not listed above:
1. Read the actual file (it's in the LOCKED-FILE-LIST file context block
   below if your plan touches it).
2. Use only exports that appear in the file's \`export ...\` statements.
3. If your plan needs an API surface that doesn't exist yet, STOP — surface
   the gap in the PR body. Do not invent module shapes.
`;

let cached: string | null = null;

export function loadAutopilotContext(): string {
  if (cached !== null) return cached;
  cached = `${CONVENTIONS.trim()}\n\n---\n\n${IMPORTS_SURFACE.trim()}`;
  console.log(`${LOG_PREFIX} loaded ${cached.length} chars of conventions + imports surface`);
  return cached;
}

/** Test-only: clear the cache so unit tests can reload after edits. */
export function _resetContextCacheForTests(): void {
  cached = null;
}
