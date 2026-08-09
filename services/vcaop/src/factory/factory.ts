/**
 * ConnectorFactory — compiles a validated ConnectorManifest into the EXISTING
 * `Connector` interface (ADR-002). Generated connectors extend BaseConnector,
 * so env-boundary → policy-engine → human-gate → CAPTCHA fire before any
 * generated logic; the factory cannot emit a connector that bypasses them.
 *
 * Compile ≠ activate: anything valid compiles (needed to run certification
 * tests), but `activateConnector` (certification.ts) refuses uncertified
 * manifests.
 */
import { z, ZodTypeAny } from 'zod';
import { BaseConnector } from '../connectors/base-connector';
import {
  BusinessIdentity,
  ConnectorMode,
  HealthResult,
  JobContext,
  OperateAction,
  OperateResult,
  ProviderAccount,
  RegisterResult,
  VerifyResult,
} from '../connectors/connector';
import { PolicyEngine } from '../guardrails/policy-engine';
import { ConnectorManifest, ManifestAction, ManifestField, validateManifest } from './manifest';

/** The generated connector's transport boundary — sandbox in tests/dev, real HTTP later. */
export interface GeneratedTransport {
  request(req: {
    action: ManifestAction;
    input: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<{ status: number; body: unknown }>;
}

export class TransportError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const CONNECTOR_MODE_BY_TYPE: Partial<Record<ConnectorManifest['connection_type'], ConnectorMode>> = {
  openapi: 'api',
  rest: 'api',
  graphql: 'api',
  mcp: 'api',
  oauth_api: 'oauth',
  platform_install: 'oauth',
  scim: 'scim',
  webhook: 'api',
  edi_sftp: 'manual',
  browser: 'browser',
  manual: 'manual',
};

function zodFor(fields: ManifestField[]): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of fields) {
    let t: ZodTypeAny =
      f.type === 'string'
        ? z.string()
        : f.type === 'number'
          ? z.number()
          : f.type === 'boolean'
            ? z.boolean()
            : f.type === 'array'
              ? z.array(z.unknown())
              : z.record(z.unknown());
    if (!f.required) t = t.optional();
    shape[f.name] = t;
  }
  return z.object(shape).passthrough();
}

export interface GeneratedValidators {
  /** Per action key: input/output validators compiled from the manifest schemas. */
  input: Record<string, ZodTypeAny>;
  output: Record<string, ZodTypeAny>;
}

export class GeneratedApiConnector extends BaseConnector {
  constructor(
    policyEngine: PolicyEngine,
    public readonly manifest: ConnectorManifest,
    private readonly transport: GeneratedTransport,
    private readonly validators: GeneratedValidators,
  ) {
    super(policyEngine);
  }

  mode(): ConnectorMode {
    return CONNECTOR_MODE_BY_TYPE[this.manifest.connection_type] ?? 'manual';
  }

  protected async doRegister(_identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    // Partner-connection registration is the Partner Portal's one-approval flow;
    // the generated connector itself never self-registers an account.
    this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, {
      providerId: ctx.providerId,
      reason: 'partner connection activation approval',
    });
  }

  protected async doVerify(ctx: JobContext): Promise<VerifyResult> {
    const health = await this.runHealthAction();
    return { verified: health.status === 'healthy', details: { providerId: ctx.providerId, ...health.details } };
  }

  protected async doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    const decl = this.manifest.actions.find((a) => a.key === action.kind);
    if (!decl) {
      // Unknown action → refuse loudly. The manifest is the whole surface.
      return { ok: false, data: { error: 'unknown_action', action: action.kind } };
    }
    if (decl.human_gated) {
      this.requireHuman('IRREVERSIBLE_SUBMIT', ctx, { providerId: ctx.providerId, action: decl.key });
    }

    const input = (action.payload ?? {}) as Record<string, unknown>;
    const inputValidator = this.validators.input[decl.key];
    if (inputValidator) {
      const parsed = inputValidator.safeParse(input);
      if (!parsed.success) {
        return { ok: false, data: { error: 'invalid_input', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
      }
    }

    const idempotencyKey =
      decl.idempotency === 'idempotency_key'
        ? String(input.idempotency_key ?? `${ctx.tenantId}:${decl.key}:${JSON.stringify(input)}`)
        : undefined;

    const result = await this.requestWithPolicy(decl, input, idempotencyKey);
    if (!result.ok) return result;

    const outputValidator = decl.output_schema ? this.validators.output[decl.key] : undefined;
    if (outputValidator) {
      const parsed = outputValidator.safeParse(result.data);
      if (!parsed.success) {
        return { ok: false, data: { error: 'invalid_output', detail: 'partner response failed schema validation (possible drift)' } };
      }
    }
    return result;
  }

  protected async doHealthCheck(_account: ProviderAccount): Promise<HealthResult> {
    return this.runHealthAction();
  }

  private async runHealthAction(): Promise<HealthResult> {
    const decl = this.manifest.actions.find((a) => a.key === this.manifest.health_check.action_key);
    if (!decl) return { status: 'unknown', details: { error: 'health action missing from manifest' } };
    try {
      const res = await this.requestWithPolicy(decl, {}, undefined);
      return res.ok ? { status: 'healthy', details: { action: decl.key } } : { status: 'degraded', details: res.data as Record<string, unknown> };
    } catch (err) {
      return { status: 'degraded', details: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Timeout + bounded-retry wrapper around the transport (manifest retry/timeout policy). */
  private async requestWithPolicy(
    decl: ManifestAction,
    input: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): Promise<OperateResult> {
    const { request_ms } = this.manifest.timeouts;
    const { max_attempts, backoff_base_ms } = this.manifest.retry;

    let lastError: unknown;
    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      try {
        const res = await withTimeout(this.transport.request({ action: decl, input, idempotencyKey }), request_ms);
        if (res.status >= 200 && res.status < 300) return { ok: true, data: res.body };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, data: { error: 'auth_failed', status: res.status } };
        }
        if (res.status >= 500 || res.status === 429) {
          lastError = new TransportError(res.status, `transient ${res.status}`);
        } else {
          return { ok: false, data: { error: 'request_failed', status: res.status } };
        }
      } catch (err) {
        lastError = err;
      }
      if (attempt < max_attempts) await sleep(backoff_base_ms * 2 ** (attempt - 1));
    }
    return { ok: false, data: { error: 'exhausted_retries', detail: lastError instanceof Error ? lastError.message : String(lastError) } };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new TransportError(0, `timeout after ${ms}ms`)), ms).unref?.()),
  ]);
}

// ---------------------------------------------------------------------------

export interface ContractTest {
  name: string;
  run(transport: GeneratedTransport, policyEngine: PolicyEngine): Promise<{ passed: boolean; detail?: string }>;
}

export interface CompiledConnector {
  manifest: ConnectorManifest;
  validators: GeneratedValidators;
  buildConnector(policyEngine: PolicyEngine, transport: GeneratedTransport): GeneratedApiConnector;
  contractTests: ContractTest[];
  /** MCP tool declarations for the read capabilities (consumed by vcaop-mcp later). */
  mcpToolDeclarations: Array<{ name: string; readOnly: boolean; requiredScopes: string[] }>;
}

function syntheticValue(f: ManifestField): unknown {
  switch (f.type) {
    case 'string':
      return f.sensitive ? 'synthetic-value' : `test-${f.name}`;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    default:
      return {};
  }
}

/** Synthetic input for an action — required fields only, never real data. */
export function syntheticInput(manifest: ConnectorManifest, action: ManifestAction): Record<string, unknown> {
  const schema = manifest.source_schemas.find((s) => s.name === action.input_schema);
  if (!schema) return {};
  return Object.fromEntries(schema.fields.filter((f) => f.required).map((f) => [f.name, syntheticValue(f)]));
}

function buildContractTests(manifest: ConnectorManifest, validators: GeneratedValidators): ContractTest[] {
  const tests: ContractTest[] = [];
  const mkCtx = (): JobContext => ({
    providerId: manifest.provider_id,
    tenantId: manifest.partner_tenant_id,
    emitHumanTask: () => undefined,
    env: { VCAOP_ENV: 'dev' } as unknown as NodeJS.ProcessEnv,
  });

  for (const action of manifest.actions.filter((a) => a.kind === 'read')) {
    tests.push({
      name: `read:${action.key} happy path returns schema-valid output`,
      run: async (transport, policyEngine) => {
        const connector = new GeneratedApiConnector(policyEngine, manifest, transport, validators);
        const res = await connector.operate({ kind: action.key, payload: syntheticInput(manifest, action) }, mkCtx());
        return res.ok ? { passed: true } : { passed: false, detail: JSON.stringify(res.data) };
      },
    });
  }

  const writable = manifest.actions.find((a) => a.kind === 'action' && !a.human_gated && a.idempotency === 'idempotency_key');
  if (writable) {
    tests.push({
      name: `write:${writable.key} duplicate idempotency key does not duplicate the effect`,
      run: async (transport, policyEngine) => {
        const connector = new GeneratedApiConnector(policyEngine, manifest, transport, validators);
        const payload = { ...syntheticInput(manifest, writable), idempotency_key: 'contract-test-dup-1' };
        const first = await connector.operate({ kind: writable.key, payload }, mkCtx());
        const second = await connector.operate({ kind: writable.key, payload }, mkCtx());
        if (!first.ok || !second.ok) return { passed: false, detail: 'write failed' };
        const a = JSON.stringify(first.data);
        const b = JSON.stringify(second.data);
        return a === b ? { passed: true } : { passed: false, detail: 'duplicate produced a different effect' };
      },
    });
    tests.push({
      name: `write:${writable.key} invalid input is rejected before the transport is called`,
      run: async (transport, policyEngine) => {
        const spy: GeneratedTransport = {
          request: async (req) => {
            if (req.action.key === writable.key) throw new Error('transport must not be reached on invalid input');
            return transport.request(req);
          },
        };
        const connector = new GeneratedApiConnector(policyEngine, manifest, spy, validators);
        const schema = manifest.source_schemas.find((s) => s.name === writable.input_schema);
        const requiredString = schema?.fields.find((f) => f.required && f.type === 'string');
        if (!requiredString) return { passed: true, detail: 'no required string field to violate — skipped' };
        const res = await connector.operate({ kind: writable.key, payload: { [requiredString.name]: 123 } }, mkCtx());
        return !res.ok ? { passed: true } : { passed: false, detail: 'invalid input was accepted' };
      },
    });
  }

  tests.push({
    name: 'auth failure surfaces as auth_failed, never as success',
    run: async (_transport, policyEngine) => {
      const denying: GeneratedTransport = { request: async () => ({ status: 401, body: {} }) };
      const connector = new GeneratedApiConnector(policyEngine, manifest, denying, validators);
      const read = manifest.actions.find((a) => a.kind === 'read') ?? manifest.actions[0];
      const res = await connector.operate({ kind: read.key, payload: syntheticInput(manifest, read) }, mkCtx());
      const data = res.data as { error?: string };
      return !res.ok && data?.error === 'auth_failed' ? { passed: true } : { passed: false, detail: JSON.stringify(res) };
    },
  });

  tests.push({
    name: 'transient 5xx is retried up to the manifest retry budget',
    run: async (_transport, policyEngine) => {
      let calls = 0;
      const flaky: GeneratedTransport = {
        request: async () => {
          calls += 1;
          return calls < manifest.retry.max_attempts ? { status: 500, body: {} } : { status: 200, body: {} };
        },
      };
      const lenient = { ...validators, output: {} };
      const connector = new GeneratedApiConnector(policyEngine, manifest, flaky, lenient);
      const read = manifest.actions.find((a) => a.kind === 'read') ?? manifest.actions[0];
      const res = await connector.operate({ kind: read.key, payload: syntheticInput(manifest, read) }, mkCtx());
      return res.ok && calls === manifest.retry.max_attempts
        ? { passed: true }
        : { passed: false, detail: `ok=${res.ok} calls=${calls}` };
    },
  });

  return tests;
}

export class ConnectorFactory {
  /** Compile a manifest. Throws on an invalid manifest; certification gates activation separately. */
  static compile(input: unknown): CompiledConnector {
    const validated = validateManifest(input);
    if (!validated.ok || !validated.manifest) {
      throw new Error(`Manifest invalid:\n- ${validated.errors.join('\n- ')}`);
    }
    const manifest = validated.manifest;

    const validators: GeneratedValidators = { input: {}, output: {} };
    for (const action of manifest.actions) {
      const inSchema = manifest.source_schemas.find((s) => s.name === action.input_schema);
      if (inSchema) validators.input[action.key] = zodFor(inSchema.fields);
      const outSchema = manifest.source_schemas.find((s) => s.name === action.output_schema);
      if (outSchema) validators.output[action.key] = zodFor(outSchema.fields);
    }

    return {
      manifest,
      validators,
      buildConnector: (policyEngine, transport) =>
        new GeneratedApiConnector(policyEngine, manifest, transport, validators),
      contractTests: buildContractTests(manifest, validators),
      mcpToolDeclarations: manifest.actions
        .filter((a) => a.kind === 'read')
        .map((a) => ({
          name: `${manifest.connector_id}_${a.key}`,
          readOnly: true,
          requiredScopes: ['vitana:partners:read'],
        })),
    };
  }
}
