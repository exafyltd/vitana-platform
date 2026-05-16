/**
 * VTID-03025: LiveKit hourly tests — Layer-A dry-run evaluator.
 *
 * Sends a synthetic user prompt through the same prompt assembly the
 * LiveKit voice agent uses, captures what Gemini WOULD call, and returns
 * the tool_calls + reply text WITHOUT executing any tool. Used by the
 * hourly runner to verify tool routing without side effects.
 *
 * Faithfully mirrors the live agent:
 *   - bootstrap context via `buildBootstrapContextPack(identity, sessionId)`
 *   - system instruction via `buildLiveSystemInstruction(...)`
 *   - tool catalog via `buildLiveApiTools('authenticated', ...)`
 *
 * Bypasses (declared out-of-scope, Layer B):
 *   - LiveKit room / audio / STT / TTS
 *   - Vertex AI Live API WebSocket transport (uses REST generateContent)
 *   - livekit-plugins-google SDK internal tool transforms
 *   - Tool execution (dry-run; no side effects)
 *
 * Drift risk: gateway hand-builds function_declarations; the live agent's
 * SDK auto-derives them from Python @function_tool decorators. Tool NAMES
 * match by construction (spec.json contract); parameter schemas may
 * differ subtly. Acceptable for tool-routing tests; not for arg-level
 * schema validation.
 */

import { randomUUID } from 'crypto';

import { getSupabase } from '../../lib/supabase';
import type { SupabaseIdentity } from '../../middleware/auth-supabase-jwt';

// NB: `buildBootstrapContextPack` / `buildLiveApiTools` (from routes/orb-live)
// AND `buildLiveSystemInstruction` (from orb/live/instruction/, which itself
// re-imports buildNavigatorPolicySection from routes/orb-live) are all
// imported LAZILY inside `evaluateLiveKitDryRun()` rather than statically
// here. Pulling them in at module-load time drags ALL of `routes/orb-live.ts`
// (14k+ lines, 30+ middleware/route registrations) into the dependency
// graph, which then breaks any test that mocks `auth-supabase-jwt`
// (e.g. `test/routes/voice-lab.test.ts`) — express barfs at module-init
// with "Route.post() requires a callback function but got a [object
// Undefined]" because the mock doesn't supply `optionalAuth`. Lazy import
// defers the load until first eval call, leaving existing test mocks alone.

export interface DryRunIdentity {
  user_id: string;
  tenant_id: string;
  vitana_id?: string | null;
  email?: string | null;
  active_role?: string;
}

export interface DryRunEvalInput {
  prompt: string;
  /** Identity to bootstrap. If omitted, falls back to the default test user
   *  resolved from VOICE_LAB_TEST_USER_ID env or the CLAUDE.md test UUID. */
  identity?: Partial<DryRunIdentity>;
  language?: string;
  voiceStyle?: string;
  currentRoute?: string | null;
  activeRole?: string;
  /** Defaults to `process.env.VOICE_LAB_TEST_MODEL` or `gemini-2.5-pro`. */
  model?: string;
}

export interface DryRunToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface DryRunEvalResult {
  tool_calls: DryRunToolCall[];
  reply_text: string;
  latency_ms: number;
  instruction_chars: number;
  tool_count: number;
  model: string;
  resolved_identity: DryRunIdentity;
  warnings?: string[];
}

/** UUID hardcoded in CLAUDE.md as the canonical Vitana platform test user. */
const FALLBACK_TEST_USER_ID = 'a27552a3-0257-4305-8ed0-351a80fd3701';

/** Email of the canonical test account (CLAUDE.md). Used as a 2nd-tier
 *  fallback when the UUID lookup misses (e.g. the user_id changed but the
 *  email account still exists). */
const FALLBACK_TEST_EMAIL = 'e2e-test@vitana.dev';

/**
 * Run one dry-run case end-to-end. Throws on unrecoverable assembly
 * failures (missing test user, no Gemini credentials, etc.). Recoverable
 * issues (bootstrap fetch returned `skippedReason`) are reported via the
 * `warnings` field on the result.
 */
export async function evaluateLiveKitDryRun(
  input: DryRunEvalInput,
): Promise<DryRunEvalResult> {
  const warnings: string[] = [];

  const identity = await resolveDryRunIdentity(input.identity);

  const language = input.language ?? 'en';
  const voiceStyle = input.voiceStyle ?? 'friendly, calm, empathetic';
  const activeRole = input.activeRole ?? identity.active_role ?? 'patient';
  const currentRoute = input.currentRoute ?? null;
  const model =
    input.model ??
    process.env.VOICE_LAB_TEST_MODEL ??
    process.env.VERTEX_MODEL ??
    'gemini-2.5-pro';

  // Bootstrap context — same call the live session does at session start.
  const sessionId = `voicelab-test-${randomUUID()}`;
  const supabaseIdentity: SupabaseIdentity = {
    user_id: identity.user_id,
    email: identity.email ?? null,
    tenant_id: identity.tenant_id,
    exafy_admin: false,
    role: 'authenticated',
    aud: null,
    exp: null,
    iat: null,
    vitana_id: identity.vitana_id ?? null,
  };

  // Lazy load — see file header for the reason.
  const [orbLiveModule, instructionModule] = await Promise.all([
    import('../../routes/orb-live'),
    import('../../orb/live/instruction/live-system-instruction'),
  ]);
  const { buildBootstrapContextPack, buildLiveApiTools } = orbLiveModule;
  const { buildLiveSystemInstruction } = instructionModule;

  const bootstrapResult = await buildBootstrapContextPack(
    supabaseIdentity,
    sessionId,
  );
  if (bootstrapResult.skippedReason) {
    warnings.push(`bootstrap_skipped:${bootstrapResult.skippedReason}`);
  }

  const systemInstruction = buildLiveSystemInstruction(
    language,
    voiceStyle,
    bootstrapResult.contextInstruction ?? undefined,
    activeRole,
    /* conversationSummary */ undefined,
    /* conversationHistory */ undefined,
    /* isReconnect */ false,
    /* lastSessionInfo */ null,
    currentRoute,
    /* recentRoutes */ null,
    /* clientContext */ undefined,
    identity.vitana_id ?? null,
  );

  // Tool catalog — Live API shape is `[{ function_declarations: [...] }]`
  // (snake_case via the BidiGenerate setup message). The Vertex SDK's
  // generateContent expects `[{ functionDeclarations: [...] }]` (camelCase).
  // Names + parameter schemas are byte-identical between the two; only the
  // wrapper key name differs.
  const liveTools = buildLiveApiTools('authenticated', currentRoute ?? undefined, activeRole);
  const sdkTools = adaptToolsForVertexSdk(liveTools);
  const toolCount = countDeclarations(sdkTools);

  const startedAt = Date.now();

  const { VertexAI } = await import('@google-cloud/vertexai');
  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? null;
  if (!projectId) {
    throw new Error(
      'evaluateLiveKitDryRun: GOOGLE_CLOUD_PROJECT not set — cannot reach Vertex',
    );
  }
  const location = process.env.VERTEX_LOCATION ?? 'us-central1';
  const vertex = new VertexAI({ project: projectId, location });

  // Same shape llm-router.ts uses; `as any` mirrors that pattern so the
  // Node SDK's narrow tool typings don't reject our adapted catalog.
  const generativeModel = vertex.getGenerativeModel({
    model,
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools: sdkTools,
    generationConfig: { maxOutputTokens: 1024 },
  } as any);

  const result = await generativeModel.generateContent({
    contents: [
      {
        role: 'user',
        parts: [{ text: input.prompt }],
      },
    ],
  });

  const latencyMs = Date.now() - startedAt;

  const candidate = result.response?.candidates?.[0];
  const parts =
    (candidate?.content?.parts as Array<{
      text?: string;
      functionCall?: { name?: string; args?: Record<string, unknown> };
    }>) ?? [];

  const tool_calls: DryRunToolCall[] = [];
  let reply_text = '';
  for (const p of parts) {
    if (p.functionCall?.name) {
      tool_calls.push({
        name: p.functionCall.name,
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
      });
    } else if (typeof p.text === 'string') {
      reply_text += p.text;
    }
  }

  return {
    tool_calls,
    reply_text: reply_text.trim(),
    latency_ms: latencyMs,
    instruction_chars: systemInstruction.length,
    tool_count: toolCount,
    model,
    resolved_identity: identity,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Resolve a complete identity for the dry-run.
 *
 * Schema reality: `app_users` carries (user_id, email, display_name,
 * vitana_id, ...) but NOT tenant_id/role — those live on the M:N
 * `user_tenants` table (tenant_id, user_id, active_role, is_primary).
 *
 * Strategy: start from `user_tenants` (which is the only place tenant_id
 * lives) and embed `app_users` so we get email + vitana_id in one query.
 * Three tiers, each terminating as soon as we have a tenant_id:
 *
 *   1. caller-supplied / env-overridden / CLAUDE.md UUID — by user_tenants.user_id
 *   2. canonical test EMAIL (`e2e-test@vitana.dev`) — by user_tenants → app_users.email
 *   3. any user_tenants row whose embedded app_users has vitana_id (oldest
 *      created_at, deterministic) — last-resort so the eval has SOME real
 *      bootstrap to render on an unfamiliar Supabase project
 *
 * Throws only if all three tiers miss AND VOICE_LAB_TEST_TENANT_ID is unset.
 */
async function resolveDryRunIdentity(
  partial?: Partial<DryRunIdentity>,
): Promise<DryRunIdentity> {
  const requestedUserId =
    partial?.user_id ??
    process.env.VOICE_LAB_TEST_USER_ID ??
    FALLBACK_TEST_USER_ID;

  let userId = requestedUserId;
  let tenantId = partial?.tenant_id ?? process.env.VOICE_LAB_TEST_TENANT_ID ?? null;
  let vitanaId = partial?.vitana_id ?? null;
  let email = partial?.email ?? null;
  let activeRole = partial?.active_role;

  // user_tenants → embedded app_users. PostgREST resource-embedding syntax:
  // `app_users(email, vitana_id)` returns the joined row inline.
  type Row = {
    user_id: string;
    tenant_id: string;
    active_role: string | null;
    app_users?: { email?: string | null; vitana_id?: string | null } | null;
  };

  const SELECT = 'user_id, tenant_id, active_role, app_users(email, vitana_id)';

  const apply = (row: Row): void => {
    userId = row.user_id ?? userId;
    if (!tenantId) tenantId = row.tenant_id ?? null;
    if (!activeRole) activeRole = row.active_role ?? undefined;
    if (!vitanaId) vitanaId = row.app_users?.vitana_id ?? null;
    if (!email) email = row.app_users?.email ?? null;
  };

  const sb = getSupabase();
  if (sb && (!tenantId || !vitanaId || !email)) {
    // Tier 1: by user_id, preferring primary membership when multi-tenant.
    const t1 = await sb
      .from('user_tenants')
      .select(SELECT)
      .eq('user_id', requestedUserId)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (t1.data) apply(t1.data as unknown as Row);

    // Tier 2: by canonical email on the embedded app_users.
    if (!tenantId) {
      const t2 = await sb
        .from('user_tenants')
        .select(SELECT)
        .eq('app_users.email', FALLBACK_TEST_EMAIL)
        .not('app_users', 'is', null)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (t2.data) apply(t2.data as unknown as Row);
    }

    // Tier 3: any user with a vitana_id (oldest created_at on user_tenants).
    if (!tenantId) {
      const t3 = await sb
        .from('user_tenants')
        .select(SELECT)
        .not('app_users.vitana_id', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (t3.data) apply(t3.data as unknown as Row);
    }
  }

  if (!tenantId) {
    throw new Error(
      'evaluateLiveKitDryRun: no usable test identity in user_tenants/app_users ' +
        `(tried user_id=${requestedUserId}, email=${FALLBACK_TEST_EMAIL}, ` +
        'and oldest vitana_id user via embedded join). ' +
        'Set VOICE_LAB_TEST_USER_ID + VOICE_LAB_TEST_TENANT_ID to override.',
    );
  }

  return {
    user_id: userId,
    tenant_id: tenantId,
    vitana_id: vitanaId,
    email,
    active_role: activeRole,
  };
}

/**
 * Translate the Live API tool catalog (snake_case `function_declarations`)
 * into the Vertex SDK shape (camelCase `functionDeclarations`).
 *
 * The Live catalog is `Array<{ function_declarations: Decl[] }>` so it
 * always returns at most ONE wrapper today, but we iterate defensively
 * in case the catalog ever splits into multiple wrappers.
 */
function adaptToolsForVertexSdk(
  liveTools: object[],
): Array<{ functionDeclarations: object[] }> {
  const out: Array<{ functionDeclarations: object[] }> = [];
  for (const entry of liveTools as Array<Record<string, unknown>>) {
    const decls = (entry as { function_declarations?: unknown }).function_declarations;
    if (Array.isArray(decls)) {
      out.push({ functionDeclarations: decls as object[] });
    } else {
      const camel = (entry as { functionDeclarations?: unknown }).functionDeclarations;
      if (Array.isArray(camel)) {
        out.push({ functionDeclarations: camel as object[] });
      }
    }
  }
  return out;
}

function countDeclarations(
  sdkTools: Array<{ functionDeclarations: object[] }>,
): number {
  return sdkTools.reduce((sum, w) => sum + (w.functionDeclarations?.length ?? 0), 0);
}
