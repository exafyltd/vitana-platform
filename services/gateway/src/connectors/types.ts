/**
 * VTID-02100: Connector framework — core types.
 *
 * Every third-party integration implements `Connector`. A connector is one
 * file in services/gateway/src/connectors/{category}/{id}.ts.
 *
 * The existing social-connect-service.ts continues to own the 6 social
 * providers for now; the framework runs alongside for wearables and future
 * connector categories. A full refactor is planned post-Phase-1.
 */

export type ConnectorCategory =
  | 'social'
  | 'wearable'
  | 'shop'
  | 'calendar'
  | 'productivity'
  | 'aggregator';

export type AuthType =
  | 'oauth2'
  | 'oauth1'
  | 'api_key'
  | 'webhook_only'
  | 'affiliate_link'
  | 'sdk_bridge'
  // VTID-01942: `none` — an always-available in-house connector (e.g. the
  // Vitana Media Hub). Resolver treats these as implicitly connected for
  // every authenticated user; dispatcher skips the token lookup and passes
  // an empty TokenPair to performAction.
  | 'none';

export interface OAuthConfig {
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id_env: string;
  client_secret_env: string;
  redirect_uri_env?: string;
  pkce?: boolean;
  extra_authorize_params?: Record<string, string>;
}

export interface NormalizedProfile {
  provider_user_id: string;
  provider_username?: string;
  display_name?: string;
  avatar_url?: string;
  profile_url?: string;
  bio?: string;
  raw: Record<string, unknown>;
}

export interface NormalizedEvent {
  /** Canonical event topic, e.g. 'connector.wearable.sleep.recorded' */
  topic: string;
  user_connection_id?: string;
  user_id?: string;
  provider: string;
  /** Provider-specific event_type (for audit). */
  provider_event_type?: string;
  /** Primary payload (already normalized to our domain). */
  payload: Record<string, unknown>;
  /** Raw payload if we want to replay or debug. */
  raw?: Record<string, unknown>;
  timestamp?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token?: string;
  expires_at?: string; // ISO
  scopes_granted?: string[];
}

export interface ConnectorContext {
  tenant_id: string;
  user_id: string;
  user_connection_id?: string;
  /**
   * VTID-01942: provider-side identity pulled from social_connections when
   * the dispatcher loaded the user's row. Used for URL decoration (e.g.
   * music.youtube.com?authuser=<email>) so browser playback picks the
   * signed-in account instead of anonymous.
   */
  provider_user_id?: string;
  provider_username?: string;
}

export interface OAuthExchangeResult {
  tokens: TokenPair;
  provider_user_id?: string;
  profile?: NormalizedProfile;
}

export interface FetchRequest {
  /** Which stream to fetch: 'sleep', 'workouts', 'profile', etc. */
  stream: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ActionRequest {
  capability: string;            // e.g. 'post.write', 'workout.write'
  args: Record<string, unknown>;
  idempotency_key?: string;
}

export interface ActionResult {
  ok: boolean;
  external_id?: string;
  url?: string;
  error?: string;
  raw?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | string | Record<string, unknown>;
  raw_body?: string;
}

export interface Connector {
  id: string;                                                    // matches connector_registry.id
  category: ConnectorCategory;
  display_name: string;
  auth_type: AuthType;
  capabilities: string[];

  /** Present if auth_type is 'oauth2' / 'oauth1'. */
  oauth?: OAuthConfig;

  /** Called at gateway startup; optional — use for client initialization. */
  initialize?(): Promise<void> | void;

  /** Build the authorize URL the user clicks to start OAuth. */
  getOAuthUrl?(state: string, redirect_uri: string): string;

  /** Exchange authorization code for tokens + optionally normalize profile. */
  exchangeCode?(code: string, redirect_uri: string): Promise<OAuthExchangeResult>;

  /** Refresh an expiring token. */
  refreshToken?(refresh_token: string): Promise<TokenPair>;

  /** Normalize a raw profile payload. */
  normalizeProfile?(raw: Record<string, unknown>): NormalizedProfile;

  /** Fetch a data stream (sleep, workouts, etc.). */
  fetchData?(ctx: ConnectorContext, tokens: TokenPair, req: FetchRequest): Promise<NormalizedEvent[]>;

  /** Perform a write action (post, log workout, purchase). Phase 3+. */
  performAction?(ctx: ConnectorContext, tokens: TokenPair, action: ActionRequest): Promise<ActionResult>;

  /** Verify + parse an incoming webhook. Returns normalized events. */
  handleWebhook?(req: WebhookRequest): Promise<{ valid: boolean; events: NormalizedEvent[]; error?: string }>;

  /** Optional: for aggregators (Terra), generate a widget URL for user to link. */
  generateWidgetUrl?(ctx: ConnectorContext, options?: Record<string, unknown>): Promise<{ url: string; session_id: string } | null>;
}

/** Minimal record returned by the registry for admin / UI listing. */
export interface ConnectorMetadata {
  id: string;
  category: ConnectorCategory;
  display_name: string;
  auth_type: AuthType;
  capabilities: string[];
  enabled: boolean;
  requires_ios_companion?: boolean;
  underlying_providers?: string[];
}
