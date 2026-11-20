import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { modelAcceptsEffort } from '../constants/llm-defaults';

/**
 * Anthropic-via-Bedrock provider (VTID-03181 VOICE-LAT W1; wired in
 * VTID-03403 W3/W4, reopened from VTID-03402 after an autopilot false
 * completion — see VTID-03402/03403 spec history).
 *
 * Still dormant until BEDROCK_ROLE_ARN is set on a real deployment (AWS
 * IAM/model-access provisioning is tracked separately in VTID-03403 and
 * requires AWS console/CLI access). The runtime check below early-returns
 * a typed error so callers can fall back to another provider seamlessly.
 *
 * Wire path: services/gateway/src/services/llm-router.ts registers a
 * `bedrockAdapter` in its `ADAPTERS` map, calling `invokeBedrock()` below.
 * There is no `conversation-router.ts` and no `preferred_provider` field —
 * that mechanism never existed; the real dispatch is per-stage via the
 * DB-backed `llm_routing_policy`, same as every other provider.
 */

/**
 * Anthropic Messages API content blocks, as accepted by Bedrock's
 * `anthropic_version: 'bedrock-2023-05-31'` payload. Identical wire shape to
 * the direct Anthropic API — that equivalence is the whole reason vision and
 * tool-calling work here without a second serializer.
 */
export type BedrockContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  // VTID-03579: the two blocks an agentic loop needs. A tool-calling turn is
  // three messages, not one — the model's tool_use, the caller's tool_result,
  // and the model's follow-up — and Anthropic pairs them by `id`/`tool_use_id`.
  // Without these the operator's tool round-trip cannot be expressed at all.
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // VTID-04868: extended-thinking blocks. Opaque — they must be echoed back
  // unchanged (signature / data included) on the assistant turn they came from.
  | BedrockThinkingBlock;

/**
 * VTID-04868: a thinking block as returned by the Messages API. Kept as an
 * open record on purpose: any field the API adds later is carried back
 * verbatim instead of being stripped by a narrower type.
 */
export type BedrockThinkingBlock =
  | ({ type: 'thinking'; thinking: string; signature: string } & Record<string, unknown>)
  | ({ type: 'redacted_thinking'; data: string } & Record<string, unknown>);

/** VTID-04868: adaptive thinking (Claude 4.6+). */
export type BedrockThinkingConfig = { type: 'adaptive' };
/** VTID-04868: output_config.effort levels accepted by Opus 4.6. */
export type BedrockEffort = 'low' | 'medium' | 'high' | 'max';

export interface BedrockTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (Anthropic calls this input_schema). */
  input_schema: unknown;
}

/** Anthropic's tool_choice. 'any' forces some tool; 'tool' forces a named one. */
export type BedrockToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface BedrockInvokeRequest {
  model: string;
  /**
   * VTID-03496: `content` widened from `string` to also accept structured
   * blocks, which is what carries images. Plain strings still work unchanged.
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string | BedrockContentBlock[] }>;
  /** Top-level system prompt, matching Anthropic's Messages API shape
   *  (including via Bedrock) — NOT a role:'system' entry in `messages`. */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  /**
   * VTID-03496: previously declared here but NEVER serialized into the request
   * body — callers passing tools got a plain text completion with no error and
   * no tool call. Now actually sent.
   */
  tools?: BedrockTool[];
  tool_choice?: BedrockToolChoice;
  /**
   * VTID-04868: extended thinking. Omitted ⇒ not sent (default, unchanged
   * request body). When set, `temperature` is NOT sent — the Messages API
   * rejects a non-default temperature alongside thinking.
   */
  thinking?: BedrockThinkingConfig;
  /** VTID-04868: passed through as `output_config` (e.g. `{ effort: 'high' }`). Omitted ⇒ not sent. */
  output_config?: { effort?: BedrockEffort };
  /**
   * VTID-05702 (plan agentic-delivery-v2 §10, §11, Phase 0 P3): true routes
   * this call through the cross-account `vitana-delivery-bedrock` role in the
   * SEPARATE `vitana-engineering` AWS account, instead of the caller's own
   * task role / BEDROCK_ROLE_ARN gate — so the delivery pipeline's
   * sparring/review traffic never shares, or depends on, production's
   * Bedrock quota. Gated on DELIVERY_BEDROCK_ROLE_ARN, independently of
   * BEDROCK_ROLE_ARN. Omitted/false ⇒ byte-for-byte today's behaviour; every
   * existing call site (llm-router.ts etc.) is unaffected.
   */
  useDeliveryRole?: boolean;
}

export interface BedrockToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /**
   * VTID-03579: the provider-assigned tool_use id. Required to send the result
   * back — Anthropic matches a tool_result to its tool_use by this id, and a
   * mismatched or missing id is a hard 400, not a soft degradation.
   */
  id?: string;
}

export interface BedrockInvokeResponse {
  ok: true;
  text: string;
  /** VTID-03496: populated when the model emitted a `tool_use` block. */
  toolCall?: BedrockToolCall;
  /**
   * VTID-03579: ALL tool_use blocks, in order. Claude can request several tools
   * in one turn; `toolCall` reports only the first, so an agentic caller reading
   * it alone would silently drop the rest and then hang waiting for results it
   * never asked for. `toolCall` is kept as the first element for back-compat.
   */
  toolCalls?: BedrockToolCall[];
  /** Anthropic stop reason, e.g. 'tool_use' | 'end_turn' | 'max_tokens'. */
  stopReason?: string;
  /**
   * VTID-04868: thinking / redacted_thinking blocks, VERBATIM and in response
   * order. Empty unless the request enabled thinking.
   */
  thinkingBlocks?: BedrockThinkingBlock[];
  model: string;
  upstream_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface BedrockInvokeError {
  ok: false;
  error: 'not_configured' | 'invoke_failed';
  message: string;
}

// VTID-03496: read at call time, not module load. Previously these were
// captured once at import, so a task definition that sets BEDROCK_ROLE_ARN
// could not be exercised without a process restart, and tests could not
// toggle configured/not-configured. Behaviour is otherwise identical.
function bedrockRoleArn(): string | undefined {
  return process.env.BEDROCK_ROLE_ARN;
}
// Plan sparring-eu-guard C2: no default region. A process without either variable must fail closed, not send
// EU model ids to a US region (the old default was us-east-1).
function bedrockRegion(): string | undefined {
  return process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || undefined;
}

// ---------------------------------------------------------------------------
// VTID-05702 — delivery-stage Bedrock calls through a cross-account role.
//
// Delivery stages (the plan-sparring responder, the review service — built in
// the later lanes `spar-responder`/`review-service`) call Bedrock through a
// role, `vitana-delivery-bedrock`, in the SEPARATE `vitana-engineering` AWS
// account (plan agentic-delivery-v2 §10, §11, Phase 0 P3), outside production's
// shared Bedrock quota in 472838866351. `scripts/aws/setup-delivery-bedrock.sh`
// provisions that role's trust policy to accept this gateway's own task role as
// principal; the task role then calls `sts:AssumeRole` on it at call time.
//
// No @aws-sdk/client-sts / @aws-sdk/credential-providers dependency: this
// lane's declared paths are exactly setup-delivery-bedrock.sh, this file and
// bedrock-role.test.ts — not package.json/pnpm-lock.yaml — so a new npm
// dependency cannot be added from inside it (the PR-GATE "Lane scope" check
// fails any file outside those three), and neither package is already
// resolvable here even transitively. The one sts:AssumeRole call this needs
// is therefore signed directly with Node's own `crypto` (Signature Version 4,
// STS's Query protocol). See bedrock-role.test.ts for the correctness check
// against a fixed worked example (independently cross-checked, during
// development, against the widely-used `aws4` reference signer).
// ---------------------------------------------------------------------------

/** Read at call time, same convention as bedrockRoleArn()/bedrockRegion() above. */
function deliveryBedrockRoleArn(): string | undefined {
  return process.env.DELIVERY_BEDROCK_ROLE_ARN || undefined;
}

/** Defaults to the same region resolution as a normal (non-delivery) call. */
function deliveryBedrockRegion(): string | undefined {
  return process.env.DELIVERY_BEDROCK_REGION || bedrockRegion();
}

const DELIVERY_ROLE_SESSION_NAME = 'vitana-gateway-delivery-bedrock';
const DELIVERY_ROLE_DURATION_SECONDS = 3600;
/** Re-assume the role this long before the assumed credentials actually expire. */
const DELIVERY_CREDENTIAL_REFRESH_SKEW_MS = 60_000;

export interface AssumedRoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

type CallerCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

// The gateway's OWN task-role credentials (already a dependency of this
// package — used elsewhere in lib/google-access-token.ts the same way).
// Built once, like google-access-token.ts's own default `defaultProvider()`
// parameter: the SDK provider caches and refreshes the underlying
// credentials itself, so repeated calls do not re-hit the ECS metadata
// endpoint on every invocation.
const taskRoleCredentialsProvider: () => Promise<CallerCredentials> = defaultProvider();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * AWS Signature Version 4 for a single, fixed shape of request: an STS
 * Query-protocol POST with an `application/x-www-form-urlencoded` body, no
 * query-string parameters, host/content-type/content-length/x-amz-date(
 * /x-amz-security-token) as the only signed headers. Pure; exported for
 * tests (same convention as buildBedrockRequestBody above).
 */
export function signAwsRequestV4(input: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  body: string;
  /** 'YYYYMMDDTHHMMSSZ' (ISO 8601 basic, UTC) — the caller supplies it so this stays pure/testable. */
  amzDate: string;
  contentType: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): { authorization: string; signedHeaders: string; canonicalRequest: string } {
  const dateStamp = input.amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const headersToSign: Record<string, string> = {
    'content-length': String(Buffer.byteLength(input.body, 'utf8')),
    'content-type': input.contentType,
    host: input.host,
    'x-amz-date': input.amzDate,
  };
  if (input.sessionToken) headersToSign['x-amz-security-token'] = input.sessionToken;

  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headersToSign[name]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [input.method, input.path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, signedHeaders, canonicalRequest };
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1];
}

/**
 * One sts:AssumeRole call, signed with the CALLER's (the gateway's own task
 * role) credentials — `getCallerCredentials` defaults to the real task role
 * but is injectable so tests never need a real AWS identity or network call.
 */
export async function assumeDeliveryBedrockRole(
  roleArn: string,
  region: string,
  getCallerCredentials: () => Promise<CallerCredentials> = taskRoleCredentialsProvider,
): Promise<AssumedRoleCredentials> {
  const caller = await getCallerCredentials();
  const host = `sts.${region}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const body = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: DELIVERY_ROLE_SESSION_NAME,
    DurationSeconds: String(DELIVERY_ROLE_DURATION_SECONDS),
  }).toString();

  const { authorization } = signAwsRequestV4({
    method: 'POST',
    host,
    path: '/',
    region,
    service: 'sts',
    body,
    amzDate,
    contentType,
    accessKeyId: caller.accessKeyId,
    secretAccessKey: caller.secretAccessKey,
    sessionToken: caller.sessionToken,
  });

  const headers: Record<string, string> = {
    'content-type': contentType,
    host,
    'x-amz-date': amzDate,
    authorization,
  };
  if (caller.sessionToken) headers['x-amz-security-token'] = caller.sessionToken;

  const res = await fetch(`https://${host}/`, { method: 'POST', headers, body });
  const xml = await res.text();
  if (!res.ok) {
    const code = extractXmlTag(xml, 'Code') ?? 'unknown';
    const message = extractXmlTag(xml, 'Message') ?? xml.slice(0, 200);
    throw new Error(`sts:AssumeRole failed (${res.status} ${code}): ${message}`);
  }

  const accessKeyId = extractXmlTag(xml, 'AccessKeyId');
  const secretAccessKey = extractXmlTag(xml, 'SecretAccessKey');
  const sessionToken = extractXmlTag(xml, 'SessionToken');
  const expiration = extractXmlTag(xml, 'Expiration');
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
    throw new Error('sts:AssumeRole returned a response with no usable Credentials block');
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt: Date.parse(expiration) };
}

let deliveryCredentialsCache: { roleArn: string; region: string; credentials: AssumedRoleCredentials } | null = null;

/**
 * Cached, refreshed sts:AssumeRole credentials for the delivery role.
 * `getCallerCredentials` is forwarded to assumeDeliveryBedrockRole() — see
 * its own doc comment; production call sites never pass it.
 */
export async function getDeliveryBedrockCredentials(
  roleArn: string,
  region: string,
  getCallerCredentials?: () => Promise<CallerCredentials>,
): Promise<AssumedRoleCredentials> {
  const cached = deliveryCredentialsCache;
  if (
    cached &&
    cached.roleArn === roleArn &&
    cached.region === region &&
    cached.credentials.expiresAt - DELIVERY_CREDENTIAL_REFRESH_SKEW_MS > Date.now()
  ) {
    return cached.credentials;
  }
  const credentials = await (getCallerCredentials
    ? assumeDeliveryBedrockRole(roleArn, region, getCallerCredentials)
    : assumeDeliveryBedrockRole(roleArn, region));
  deliveryCredentialsCache = { roleArn, region, credentials };
  return credentials;
}

/** Test hook: forget the cached delivery-role credentials. */
export function __resetDeliveryBedrockCredentialsCacheForTests(): void {
  deliveryCredentialsCache = null;
}

/**
 * Extract the text and tool_use blocks from an Anthropic Messages response.
 *
 * VTID-03496: the previous implementation read `content[0]?.text` only. With a
 * forced tool call the FIRST block is `tool_use`, which has no `.text`, so
 * text came back empty; and with multiple text blocks it silently truncated to
 * the first. Both are now handled by filtering across all blocks.
 */
export function parseBedrockContent(payload: {
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}): { text: string; toolCall?: BedrockToolCall; toolCalls: BedrockToolCall[]; thinkingBlocks: BedrockThinkingBlock[] } {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  // VTID-03579: collect EVERY tool_use block, not just the first. Claude emits
  // parallel tool calls in a single turn; taking `.find()` silently executed one
  // and dropped the others, which reads downstream as the model ignoring its own
  // request.
  const toolCalls = blocks
    .filter(
      (b) =>
        b?.type === 'tool_use' &&
        typeof b.name === 'string' &&
        b.input &&
        typeof b.input === 'object',
    )
    .map((b) => ({
      name: b.name as string,
      arguments: b.input as Record<string, unknown>,
      id: typeof b.id === 'string' ? b.id : undefined,
    }));
  // VTID-04868: thinking blocks are kept exactly as received (a shallow copy of
  // the whole block, every field) — re-serialising them from a narrower shape
  // would drop the signature and the next tool turn would be rejected.
  const thinkingBlocks = blocks
    .filter((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking')
    .map((b) => ({ ...b }) as BedrockThinkingBlock);
  return { text, toolCall: toolCalls[0], toolCalls, thinkingBlocks };
}

export async function invokeBedrock(
  req: BedrockInvokeRequest,
): Promise<BedrockInvokeResponse | BedrockInvokeError> {
  const useDelivery = req.useDeliveryRole === true;
  let region: string | undefined;
  // Set only for a delivery-role call; a normal call keeps using the
  // BedrockRuntimeClient's own default credential chain (the caller's task
  // role), exactly as before this VTID.
  let deliveryCredentials: CallerCredentials | undefined;

  if (useDelivery) {
    // VTID-05702: independent of BEDROCK_ROLE_ARN — a delivery-stage call
    // does not depend on (or share) the same-account production grant.
    const roleArn = deliveryBedrockRoleArn();
    if (!roleArn) {
      return {
        ok: false,
        error: 'not_configured',
        message:
          'DELIVERY_BEDROCK_ROLE_ARN env var not set; delivery-stage Bedrock calls are dormant until the owner runs ' +
          'scripts/aws/setup-delivery-bedrock.sh --apply in the vitana-engineering account (VTID-05702)',
      };
    }
    region = deliveryBedrockRegion();
    if (!region) {
      return {
        ok: false,
        error: 'not_configured',
        message:
          'DELIVERY_BEDROCK_REGION, AWS_BEDROCK_REGION or AWS_REGION must be set (EU region) for a delivery-role Bedrock call',
      };
    }
    try {
      deliveryCredentials = await getDeliveryBedrockCredentials(roleArn, region);
    } catch (err) {
      return {
        ok: false,
        error: 'invoke_failed',
        message: `delivery role credentials: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    if (!bedrockRoleArn()) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'BEDROCK_ROLE_ARN env var not set; Bedrock is dormant until AWS provisioning lands (VTID-03403)',
      };
    }
    region = bedrockRegion();
    if (!region) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'AWS_BEDROCK_REGION or AWS_REGION must be set (EU region); there is no default region',
      };
    }
  }

  const start = Date.now();
  try {
    // Force HTTP/1.1: the SDK's default handler can negotiate HTTP/2 against
    // Bedrock Runtime's regional endpoint, which breaks inside Cloud Run's
    // sandboxed network stack (NGHTTP2_PROTOCOL_ERROR — confirmed via a real
    // staging call in VTID-03403). NodeHttpHandler forces HTTP/1.1.
    const client = new BedrockRuntimeClient({
      region,
      requestHandler: new NodeHttpHandler(),
      // VTID-05702: explicit credentials ONLY for a delivery-role call.
      // Omitted otherwise ⇒ the client's own default provider chain (the
      // caller's task role), unchanged from before this VTID.
      ...(deliveryCredentials ? { credentials: deliveryCredentials } : {}),
    });
    const body = JSON.stringify(buildBedrockRequestBody(req));
    const command = new InvokeModelCommand({
      modelId: req.model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const resp = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const { text, toolCall, toolCalls, thinkingBlocks } = parseBedrockContent(payload);
    return {
      ok: true,
      text,
      toolCall,
      toolCalls,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
      stopReason: typeof payload?.stop_reason === 'string' ? payload.stop_reason : undefined,
      model: req.model,
      upstream_ms: Date.now() - start,
      usage: {
        input_tokens: payload.usage?.input_tokens,
        output_tokens: payload.usage?.output_tokens,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: 'invoke_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the InvokeModel JSON body. Pure; exported for tests (VTID-04868).
 * Without `thinking`/`output_config` the body is exactly what shipped before.
 *
 * VTID (sparring-model-fallback): `output_config` (which carries `effort`) is
 * sent ONLY to models that accept it (`modelAcceptsEffort`). Opus 4.6 accepts
 * it; Opus 4.5 and (conservatively) every other model do not — Opus 4.5
 * rejected it with "output_config.effort: Extra inputs are not permitted", so
 * sending it to the Sonnet 4.6 throttle-fallback would break every invoke.
 * `thinking` is left as-is (adaptive thinking is broadly accepted); if a future
 * fallback model rejects it too, extend the gate the same way.
 */
export function buildBedrockRequestBody(req: BedrockInvokeRequest): Record<string, unknown> {
  const sendOutputConfig = !!req.output_config && modelAcceptsEffort(req.model);
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: req.max_tokens ?? 2048,
    // VTID-04868: temperature is omitted when thinking is on (the API only
    // accepts the default with extended thinking).
    ...(req.thinking ? {} : { temperature: req.temperature ?? 0.5 }),
    ...(req.system ? { system: req.system } : {}),
    messages: req.messages,
    // VTID-03496: tools/tool_choice are now serialized. Omitted entirely
    // when absent — Bedrock rejects a null/empty `tools` key rather than
    // treating it as "no tools".
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
    ...(req.thinking ? { thinking: req.thinking } : {}),
    ...(sendOutputConfig ? { output_config: req.output_config } : {}),
  };
}
