/**
 * iOS App Store Connect handler (R14).
 *
 * STUB — Phase 5 scaffold. Production implementation needs:
 *
 *   - APP_STORE_CONNECT_KEY_ID         (string — the key identifier)
 *   - APP_STORE_CONNECT_ISSUER_ID      (string — the issuer/team UUID)
 *   - APP_STORE_CONNECT_PRIVATE_KEY    (PEM string — the signing key)
 *
 * Implementation outline:
 *   1. Mint a JWT signed with ES256 using the private key (10 min TTL).
 *   2. GET /v1/apps?filter[bundleId]=... to find the app id.
 *   3. GET /v1/apps/{id}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,...
 *      to find the next pending version.
 *   4. PATCH /v1/appStoreVersionLocalizations/{locId} with body containing
 *      attributes.whatsNew = changelog (rendered as plain text — App Store
 *      Connect doesn't support markdown).
 *
 * Reference: https://developer.apple.com/documentation/appstoreconnectapi
 */

interface ReleasePromotedPayload {
  component_slug: string;
  component_id: string;
  version: string;
  release_id: string;
}

export async function handleIos(payload: ReleasePromotedPayload): Promise<void> {
  const haveCreds =
    !!process.env.APP_STORE_CONNECT_KEY_ID &&
    !!process.env.APP_STORE_CONNECT_ISSUER_ID &&
    !!process.env.APP_STORE_CONNECT_PRIVATE_KEY;

  if (!haveCreds) {
    throw new Error(
      'NOT_IMPLEMENTED: App Store Connect credentials missing. Provision APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_PRIVATE_KEY before enabling iOS propagation.'
    );
  }

  // TODO(R14): implement JWT signing + App Store Connect API calls
  console.log('[release-publisher.ios] would push changelog for', payload.version, '— R14 implementation pending');
  throw new Error('NOT_IMPLEMENTED: iOS handler body — see services/release-publisher/src/handlers/ios.ts TODO');
}
