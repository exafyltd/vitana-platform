/**
 * VTID-04711: which surface a connection action came from, recorded as
 * `surface` on every connection OASIS event. The OAuth callbacks are public
 * redirects with no session, so the surface that started the flow travels in
 * the signed (Shopify) / encrypted (FHIR) state and is read back here.
 */
export const CONNECTION_SURFACES = ['merchant_self_service', 'partner_onboarding'] as const;
export type ConnectionSurface = typeof CONNECTION_SURFACES[number];

export const DEFAULT_CONNECTION_SURFACE: ConnectionSurface = 'merchant_self_service';

/** Any unknown or missing value (including a state minted before VTID-04711) is the merchant surface. */
export function resolveConnectionSurface(value: unknown): ConnectionSurface {
  return (CONNECTION_SURFACES as readonly string[]).includes(value as string)
    ? (value as ConnectionSurface)
    : DEFAULT_CONNECTION_SURFACE;
}
