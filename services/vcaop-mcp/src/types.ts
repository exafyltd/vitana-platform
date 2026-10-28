/**
 * Shared types for the Vitanaland public MCP gateway (Commerce Mesh Phase 1).
 *
 * Security model (ADR-004/ADR-005): this service holds NO business logic and
 * NO secrets beyond its own token-verification key reference. Every tool is
 * individually declared (scopes, risk, read-only, audit type) and checked
 * centrally; there is deliberately no generic passthrough tool.
 */

/** Authenticated caller context, derived ONLY from the verified access token. */
export interface AuthContext {
  /** Vitanaland user id (token `sub`). */
  userId: string;
  /** Tenant the token is bound to (token `tenant_id`). */
  tenantId: string;
  /** Granted OAuth scopes. */
  scopes: string[];
  /** OAuth client that obtained the token (e.g. a ChatGPT/Claude connector registration). */
  clientId: string;
  /** Token id, used for revocation checks. */
  jti?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** Declarative per-tool contract (brief Sec. 7). Data, not code. */
export interface ToolDeclaration {
  name: string;
  title: string;
  description: string;
  /** OAuth scopes required — ALL must be present on the token. */
  requiredScopes: string[];
  riskLevel: RiskLevel;
  readOnly: boolean;
  destructive: boolean;
  /** Whether the AI client must obtain explicit user confirmation before calling. */
  confirmationRequired: boolean;
  /** 'none' for reads; write tools (Phase 6) will declare 'idempotency_key'. */
  idempotency: 'none' | 'idempotency_key';
  /** OASIS-style audit topic emitted on every call. */
  auditEventType: string;
  /** Names of policy checks applied centrally (documentation + test hooks). */
  policyChecks: string[];
}

/** Stable error codes — part of the public contract, never renamed. */
export type McpErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden_scope'
  | 'forbidden_tenant'
  | 'not_found'
  | 'confirmation_required'
  | 'rate_limited'
  | 'backend_unavailable'
  | 'internal';

export class ToolError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
