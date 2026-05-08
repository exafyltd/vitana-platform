/**
 * VTID-02403: AI Assistants (ChatGPT + Claude) — Phase 1
 *
 * Endpoints (mounted at /api/v1/integrations/ai-assistants):
 *   GET    /providers          — catalog filtered by tenant policy
 *   POST   /apikey/:provider   — accept + encrypt API key, upsert connection
 *   POST   /verify/:provider   — live verification against provider
 *   GET    /connections        — current user's AI connections
 *   DELETE /:provider          — soft-disconnect + purge encrypted key
 *
 * Scope:
 *   - API-key paste ONLY (no OAuth, no MCP, no cost UI, no kill-switch).
 *   - Providers: chatgpt (OpenAI), claude (Anthropic).
 *   - Encryption: AES-256-GCM with env key AI_CREDENTIALS_ENC_KEY (32 bytes hex).
 *   - NEVER returns decrypted key material over the wire.
 */

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
router.use(requireAuth);

const VTID = 'VTID-02403';
const LOG_PREFIX = '[AI-Assistants]';

// ---------------------------------------------------------------------------
// Supported providers (Phase 1 allowlist)
// ---------------------------------------------------------------------------

type ProviderId = 'chatgpt' | 'claude';
const SUPPORTED: ReadonlyArray<ProviderId> = ['chatgpt', 'claude'] as const;
function isSupportedProvider(p: string): p is ProviderId {
  return (SUPPORTED as readonly string[]).includes(p);
}

interface ProviderConfig {
  display_name: string;
  prefix: string;
  verify_url: string;
  verify_method: 'GET' | 'POST';
  verify_headers: (key: string) => Record<string, string>;
  verify_body?: string;
  default_model: string;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  chatgpt: {
    display_name: 'ChatGPT',
    prefix: 'sk-',
    verify_url: 'https://api.openai.com/v1/models',
    verify_method: 'GET',
    verify_headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    }),
    default_model: 'gpt-4o-mini',
  },
  claude: {
    display_name: 'Claude',
    prefix: 'sk-ant-',
    verify_url: 'https://api.anthropic.com/v1/messages',
    verify_method: 'POST',
    verify_headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }),
    verify_body: JSON.stringify({
      // BOOTSTRAP-AI-VERIFY-MODEL: claude-3-5-haiku-20241022 was deprecated
      // by Anthropic and returns not_found_error. Current Haiku is 4.5.
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    default_model: 'claude-haiku-4-5-20251001',
  },
};

// ---------------------------------------------------------------------------
// Tenant helpers
// ---------------------------------------------------------------------------

async function resolveTenantId(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

// ---------------------------------------------------------------------------
// AES-256-GCM encryption helpers (enc key from env)
// ---------------------------------------------------------------------------

function getEncKey(): Buffer | null {
  const hex = process.env.AI_CREDENTIALS_ENC_KEY;
  if (!hex) return null;
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      console.error(`${LOG_PREFIX} AI_CREDENTIALS_ENC_KEY must be 32 bytes (64 hex chars), got ${buf.length}`);
      return null;
    }
    return buf;
  } catch (err) {
    console.error(`${LOG_PREFIX} AI_CREDENTIALS_ENC_KEY invalid hex`, err);
    return null;
  }
}

function encryptApiKey(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } | null {
  const key = getEncKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct, iv, tag };
}

function decryptApiKey(ciphertext: Buffer, iv: Buffer, tag: Buffer): string | null {
  const key = getEncKey();
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    console.error(`${LOG_PREFIX} decrypt failed`, err);
    return null;
  }
}

// Supabase returns bytea as \x-prefixed hex string or Buffer depending on client.
function toBuffer(v: unknown): Buffer | null {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') {
    const s = v.startsWith('\\x') ? v.slice(2) : v;
    try { return Buffer.from(s, 'hex'); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consent log helper
// ---------------------------------------------------------------------------

async function logConsent(params: {
  user_id: string | null;
  tenant_id: string | null;
  provider: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actor_role?: string;
  actor_id?: string | null;
}): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    await supabase.from('ai_consent_log').insert({
      user_id: params.user_id,
      tenant_id: params.tenant_id,
      provider: params.provider,
      action: params.action,
      before_jsonb: params.before ?? null,
      after_jsonb: params.after ?? null,
      actor_role: params.actor_role ?? 'user',
      actor_id: params.actor_id ?? params.user_id,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} consent log insert failed`, err);
  }
}

// =============================================================================
// GET /providers — tenant-aware catalog
// =============================================================================
router.get('/providers', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity!.user_id;
  const tokenTenantId = req.identity!.tenant_id;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantId = tokenTenantId ?? (await resolveTenantId(userId));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_NOT_FOUND' });

  // Catalog
  const { data: registry, error: regErr } = await supabase
    .from('connector_registry')
    .select('id, display_name, description, auth_type, capabilities, docs_url, enabled')
    .eq('category', 'ai_assistant')
    .eq('enabled', true)
    .order('display_name', { ascending: true });
  if (regErr) {
    console.error(`${LOG_PREFIX} GET /providers registry err`, regErr.message);
    return res.status(500).json({ ok: false, error: regErr.message });
  }

  // Tenant policy
  const { data: policies } = await supabase
    .from('ai_provider_policies')
    .select('provider, allowed, allowed_models, cost_cap_usd_month')
    .eq('tenant_id', tenantId);
  const policyByProvider = new Map(
    (policies ?? []).map((p) => [p.provider, p])
  );

  // Active connections for this user
  const { data: connections } = await supabase
    .from('user_connections')
    .select('id, connector_id, is_active, connected_at')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant');
  const connByProvider = new Map(
    (connections ?? []).filter((c) => c.is_active).map((c) => [c.connector_id, c])
  );

  // Last verification per connection (from credentials metadata)
  const connectionIds = (connections ?? []).map((c) => c.id);
  let credsByConnection = new Map<string, { last_verified_at: string | null; last_verify_status: string | null }>();
  if (connectionIds.length > 0) {
    const { data: creds } = await supabase
      .from('ai_assistant_credentials')
      .select('connection_id, last_verified_at, last_verify_status')
      .in('connection_id', connectionIds);
    credsByConnection = new Map(
      (creds ?? []).map((c) => [c.connection_id, { last_verified_at: c.last_verified_at, last_verify_status: c.last_verify_status }])
    );
  }

  const providers = (registry ?? []).map((r) => {
    const policy = policyByProvider.get(r.id);
    const tenantAllowed = policy?.allowed !== false; // absent row => default to NOT allowed for non-Maxina tenants
    const hasPolicy = !!policy;
    const conn = connByProvider.get(r.id);
    const credMeta = conn ? credsByConnection.get(conn.id) : undefined;
    let status: 'connected' | 'available' | 'disabled' = 'disabled';
    if (!hasPolicy || !tenantAllowed) status = 'disabled';
    else if (conn) status = 'connected';
    else status = 'available';

    return {
      provider: r.id,
      display_name: r.display_name,
      description: r.description,
      docs_url: r.docs_url,
      capabilities: r.capabilities,
      auth_type: r.auth_type,
      status,
      connection_id: conn?.id ?? null,
      last_verified_at: credMeta?.last_verified_at ?? null,
      last_verify_status: credMeta?.last_verify_status ?? null,
      allowed_models: policy?.allowed_models ?? [],
      cost_cap_usd_month: policy?.cost_cap_usd_month ?? null,
    };
  });

  return res.json({ ok: true, providers });
});

// =============================================================================
// POST /apikey/:provider — encrypt + persist
// =============================================================================
router.post('/apikey/:provider', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity!.user_id;
  const tokenTenantId = req.identity!.tenant_id;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const provider = req.params.provider;
  if (!isSupportedProvider(provider)) {
    return res.status(404).json({ ok: false, error: 'UNKNOWN_PROVIDER' });
  }
  const cfg = PROVIDERS[provider];

  const apiKey: unknown = req.body?.api_key;
  if (typeof apiKey !== 'string' || apiKey.length < 10) {
    return res.status(400).json({ ok: false, error: 'API_KEY_MISSING_OR_TOO_SHORT' });
  }
  if (!apiKey.startsWith(cfg.prefix)) {
    return res.status(400).json({ ok: false, error: `API_KEY_MUST_START_WITH_${cfg.prefix.replace(/-/g, '_').toUpperCase()}` });
  }

  const tenantId = tokenTenantId ?? (await resolveTenantId(userId));
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_NOT_FOUND' });

  // Tenant must allow this provider
  const { data: policy } = await supabase
    .from('ai_provider_policies')
    .select('allowed')
    .eq('tenant_id', tenantId)
    .eq('provider', provider)
    .maybeSingle();
  if (!policy || policy.allowed !== true) {
    return res.status(403).json({ ok: false, error: 'PROVIDER_NOT_ALLOWED_FOR_TENANT' });
  }

  // Encrypt
  const encrypted = encryptApiKey(apiKey);
  if (!encrypted) {
    console.error(`${LOG_PREFIX} missing/invalid AI_CREDENTIALS_ENC_KEY — cannot encrypt`);
    return res.status(503).json({ ok: false, error: 'ENCRYPTION_UNAVAILABLE' });
  }

  const key_prefix = cfg.prefix;
  const key_last4 = apiKey.slice(-4);

  // Upsert connection
  const { data: existing } = await supabase
    .from('user_connections')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .is('provider_user_id', null)
    .limit(1)
    .maybeSingle();

  let connectionId: string;
  if (existing?.id) {
    connectionId = existing.id;
    const { error: updErr } = await supabase
      .from('user_connections')
      .update({
        is_active: true,
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        last_error: null,
      })
      .eq('id', connectionId);
    if (updErr) {
      console.error(`${LOG_PREFIX} POST /apikey/${provider} update err`, updErr.message);
      return res.status(500).json({ ok: false, error: updErr.message });
    }
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('user_connections')
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        connector_id: provider,
        category: 'ai_assistant',
        display_name: cfg.display_name,
        is_active: true,
        connected_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (insErr || !inserted) {
      console.error(`${LOG_PREFIX} POST /apikey/${provider} insert err`, insErr?.message);
      return res.status(500).json({ ok: false, error: insErr?.message || 'INSERT_FAILED' });
    }
    connectionId = inserted.id;
  }

  // Upsert credentials (service role)
  const { error: credErr } = await supabase
    .from('ai_assistant_credentials')
    .upsert(
      {
        connection_id: connectionId,
        encrypted_key: `\\x${encrypted.ciphertext.toString('hex')}`,
        encryption_iv: `\\x${encrypted.iv.toString('hex')}`,
        encryption_tag: `\\x${encrypted.tag.toString('hex')}`,
        key_prefix,
        key_last4,
        last_verified_at: null,
        last_verify_status: null,
        last_verify_error: null,
        verify_failure_count: 0,
      },
      { onConflict: 'connection_id' }
    );
  if (credErr) {
    console.error(`${LOG_PREFIX} POST /apikey/${provider} cred upsert err`, credErr.message);
    return res.status(500).json({ ok: false, error: credErr.message });
  }

  await logConsent({
    user_id: userId,
    tenant_id: tenantId,
    provider,
    action: 'connect',
    after: { connection_id: connectionId, key_last4 },
  });

  return res.json({ ok: true, connection_id: connectionId, key_prefix, key_last4 });
});

// =============================================================================
// POST /verify/:provider — live check against provider
// =============================================================================
router.post('/verify/:provider', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity!.user_id;
  const tokenTenantId = req.identity!.tenant_id;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const provider = req.params.provider;
  if (!isSupportedProvider(provider)) {
    return res.status(404).json({ ok: false, error: 'UNKNOWN_PROVIDER' });
  }
  const cfg = PROVIDERS[provider];

  const { data: conn, error: connErr } = await supabase
    .from('user_connections')
    .select('id, is_active')
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (connErr) return res.status(500).json({ ok: false, error: connErr.message });
  if (!conn) return res.status(404).json({ ok: false, error: 'CONNECTION_NOT_FOUND' });

  const { data: cred, error: credErr } = await supabase
    .from('ai_assistant_credentials')
    .select('encrypted_key, encryption_iv, encryption_tag, verify_failure_count')
    .eq('connection_id', conn.id)
    .maybeSingle();
  if (credErr) return res.status(500).json({ ok: false, error: credErr.message });
  if (!cred) return res.status(404).json({ ok: false, error: 'CREDENTIAL_NOT_FOUND' });

  const ct = toBuffer(cred.encrypted_key);
  const iv = toBuffer(cred.encryption_iv);
  const tag = toBuffer(cred.encryption_tag);
  if (!ct || !iv || !tag) {
    return res.status(500).json({ ok: false, error: 'CREDENTIAL_CORRUPT' });
  }
  const apiKey = decryptApiKey(ct, iv, tag);
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'DECRYPTION_FAILED' });
  }

  // Live verification
  const startedAt = Date.now();
  let status = 200;
  let verifyStatus: 'ok' | 'unauthorized' | 'network' | 'error' = 'ok';
  let errorMessage: string | null = null;
  try {
    const resp = await fetch(cfg.verify_url, {
      method: cfg.verify_method,
      headers: cfg.verify_headers(apiKey),
      body: cfg.verify_body,
    });
    status = resp.status;
    if (resp.ok) {
      verifyStatus = 'ok';
    } else if (resp.status === 401 || resp.status === 403) {
      verifyStatus = 'unauthorized';
      try { errorMessage = (await resp.text()).slice(0, 500); } catch { errorMessage = null; }
    } else {
      verifyStatus = 'error';
      try { errorMessage = (await resp.text()).slice(0, 500); } catch { errorMessage = null; }
    }
  } catch (err: unknown) {
    verifyStatus = 'network';
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Date.now() - startedAt;
  // Rule 19: log provider + model + latency for AI calls
  console.log(
    `${LOG_PREFIX} verify provider=${provider} model=${cfg.default_model} latency_ms=${latencyMs} status=${status} verify_status=${verifyStatus}`
  );

  // Update credential row
  const nowIso = new Date().toISOString();
  const newFailureCount = verifyStatus === 'ok' ? 0 : (cred.verify_failure_count || 0) + 1;
  const updates: Record<string, unknown> = {
    last_verified_at: nowIso,
    last_verify_status: verifyStatus,
    last_verify_error: errorMessage,
    verify_failure_count: newFailureCount,
  };
  await supabase.from('ai_assistant_credentials').update(updates).eq('connection_id', conn.id);

  // Deactivate after 3 consecutive failures
  if (verifyStatus !== 'ok' && newFailureCount >= 3) {
    await supabase
      .from('user_connections')
      .update({ is_active: false, last_error: `verify_${verifyStatus}` })
      .eq('id', conn.id);
  }

  // Tenant id for audit/oasis
  const tenantId = tokenTenantId ?? (await resolveTenantId(userId));

  // OASIS: emit only on real state transitions
  if (verifyStatus === 'ok') {
    emitOasisEvent({
      vtid: VTID,
      type: 'integration.ai.connected',
      source: 'gateway',
      status: 'success',
      message: `AI provider verified: ${provider}`,
      payload: { provider, model: cfg.default_model, latency_ms: latencyMs, user_id: userId, tenant_id: tenantId },
    }).catch(() => {});
    await logConsent({
      user_id: userId,
      tenant_id: tenantId,
      provider,
      action: 'verify_ok',
      after: { latency_ms: latencyMs },
    });
  } else {
    emitOasisEvent({
      vtid: VTID,
      type: 'integration.ai.verify_failed',
      source: 'gateway',
      status: 'error',
      message: `AI provider verify failed: ${provider} (${verifyStatus})`,
      payload: {
        provider,
        model: cfg.default_model,
        latency_ms: latencyMs,
        verify_status: verifyStatus,
        http_status: status,
        failure_count: newFailureCount,
        user_id: userId,
        tenant_id: tenantId,
      },
    }).catch(() => {});
    await logConsent({
      user_id: userId,
      tenant_id: tenantId,
      provider,
      action: 'verify_failed',
      after: { verify_status: verifyStatus, http_status: status, failure_count: newFailureCount },
    });
  }

  return res.json({
    ok: verifyStatus === 'ok',
    provider,
    status: verifyStatus,
    http_status: status,
    latency_ms: latencyMs,
    error: verifyStatus === 'ok' ? null : errorMessage,
  });
});

// =============================================================================
// GET /connections — user's AI connections
// =============================================================================
router.get('/connections', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity!.user_id;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data: conns, error } = await supabase
    .from('user_connections')
    .select('id, connector_id, is_active, connected_at, disconnected_at, last_error')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const ids = (conns ?? []).map((c) => c.id);
  let credMap = new Map<string, { key_prefix: string; key_last4: string; last_verified_at: string | null; last_verify_status: string | null }>();
  if (ids.length > 0) {
    const { data: creds } = await supabase
      .from('ai_assistant_credentials')
      .select('connection_id, key_prefix, key_last4, last_verified_at, last_verify_status')
      .in('connection_id', ids);
    credMap = new Map(
      (creds ?? []).map((c) => [
        c.connection_id,
        {
          key_prefix: c.key_prefix,
          key_last4: c.key_last4,
          last_verified_at: c.last_verified_at,
          last_verify_status: c.last_verify_status,
        },
      ])
    );
  }

  const connections = (conns ?? []).map((c) => {
    const cred = credMap.get(c.id);
    return {
      connection_id: c.id,
      provider: c.connector_id,
      status: c.is_active ? 'connected' : 'disconnected',
      key_prefix: cred?.key_prefix ?? null,
      key_last4: cred?.key_last4 ?? null,
      last_verified_at: cred?.last_verified_at ?? null,
      last_verify_status: cred?.last_verify_status ?? null,
      connected_at: c.connected_at,
      disconnected_at: c.disconnected_at,
    };
  });

  return res.json({ ok: true, connections });
});

// =============================================================================
// DELETE /:provider — soft-disconnect + purge encrypted key
// =============================================================================
router.delete('/:provider', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.identity!.user_id;
  const tokenTenantId = req.identity!.tenant_id;

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const provider = req.params.provider;
  if (!isSupportedProvider(provider)) {
    return res.status(404).json({ ok: false, error: 'UNKNOWN_PROVIDER' });
  }

  const { data: conn } = await supabase
    .from('user_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('connector_id', provider)
    .eq('category', 'ai_assistant')
    .eq('is_active', true)
    .maybeSingle();
  if (!conn) return res.status(404).json({ ok: false, error: 'CONNECTION_NOT_FOUND' });

  const { error: updErr } = await supabase
    .from('user_connections')
    .update({ is_active: false, disconnected_at: new Date().toISOString() })
    .eq('id', conn.id);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  // Purge encrypted_key — overwrite with all-zero bytea (preserve row for audit)
  const zeros = `\\x${'00'.repeat(32)}`;
  const zeroIv = `\\x${'00'.repeat(12)}`;
  const zeroTag = `\\x${'00'.repeat(16)}`;
  await supabase
    .from('ai_assistant_credentials')
    .update({
      encrypted_key: zeros,
      encryption_iv: zeroIv,
      encryption_tag: zeroTag,
      last_verify_status: 'purged',
    })
    .eq('connection_id', conn.id);

  const tenantId = tokenTenantId ?? (await resolveTenantId(userId));
  emitOasisEvent({
    vtid: VTID,
    type: 'integration.ai.disconnected',
    source: 'gateway',
    status: 'info',
    message: `AI provider disconnected: ${provider}`,
    payload: { provider, user_id: userId, tenant_id: tenantId, connection_id: conn.id },
  }).catch(() => {});
  await logConsent({
    user_id: userId,
    tenant_id: tenantId,
    provider,
    action: 'disconnect',
    before: { connection_id: conn.id },
  });

  return res.json({ ok: true, provider });
});

export default router;