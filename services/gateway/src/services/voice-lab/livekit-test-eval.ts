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
 * Resolve a complete identity for the dry-run from the caller's partial
 * input + env + DB. Falls back to the hardcoded CLAUDE.md test user.
 * Looks up tenant_id via `app_users` if not supplied.
 */
async function resolveDryRunIdentity(
  partial?: Partial<DryRunIdentity>,
): Promise<DryRunIdentity> {
  const userId =
    partial?.user_id ??
    process.env.VOICE_LAB_TEST_USER_ID ??
    FALLBACK_TEST_USER_ID;

  let tenantId = partial?.tenant_id ?? process.env.VOICE_LAB_TEST_TENANT_ID ?? null;
  let vitanaId = partial?.vitana_id ?? null;
  let email = partial?.email ?? null;
  let activeRole = partial?.active_role;

  if (!tenantId || !vitanaId || !email) {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb
        .from('app_users')
        .select('user_id, tenant_id, vitana_id, email, role')
        .eq('user_id', userId)
        .maybeSingle();
      if (data) {
        if (!tenantId) tenantId = (data as { tenant_id?: string | null }).tenant_id ?? null;
        if (!vitanaId) vitanaId = (data as { vitana_id?: string | null }).vitana_id ?? null;
        if (!email) email = (data as { email?: string | null }).email ?? null;
        if (!activeRole) {
          activeRole = (data as { role?: string | null }).role ?? undefined;
        }
      }
    }
  }

  if (!tenantId) {
    throw new Error(
      `evaluateLiveKitDryRun: tenant_id unresolved for user ${userId} — ` +
        'pass identity.tenant_id explicitly or set VOICE_LAB_TEST_TENANT_ID',
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
