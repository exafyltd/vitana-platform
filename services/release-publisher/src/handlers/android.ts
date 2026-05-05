/**
 * Android Play Developer API handler (R15).
 *
 * STUB — Phase 5 scaffold. Production implementation needs:
 *
 *   - PLAY_CONSOLE_SERVICE_ACCOUNT_JSON (full JSON content of a Play Console service account key)
 *
 * Implementation outline:
 *   1. Authenticate via OAuth2 using google-auth-library + service account JSON
 *      (scope: https://www.googleapis.com/auth/androidpublisher).
 *   2. POST /androidpublisher/v3/applications/{packageName}/edits to start an edit.
 *   3. GET /edits/{editId}/tracks to find the right track (production / beta / internal
 *      based on the release's channel).
 *   4. PATCH /edits/{editId}/tracks/{track} with releases[].releaseNotes[]
 *      = [{ language: 'en-US', text: changelog }].
 *   5. POST /edits/{editId}:commit to commit the edit.
 *
 * Reference: https://developers.google.com/android-publisher/api-ref/rest
 */

interface ReleasePromotedPayload {
  component_slug: string;
  component_id: string;
  version: string;
  release_id: string;
}

export async function handleAndroid(payload: ReleasePromotedPayload): Promise<void> {
  const haveCreds = !!process.env.PLAY_CONSOLE_SERVICE_ACCOUNT_JSON;

  if (!haveCreds) {
    throw new Error(
      'NOT_IMPLEMENTED: Play Console service account missing. Provision PLAY_CONSOLE_SERVICE_ACCOUNT_JSON before enabling Android propagation.'
    );
  }

  // TODO(R15): implement OAuth2 + Play Developer API calls
  console.log('[release-publisher.android] would push changelog for', payload.version, '— R15 implementation pending');
  throw new Error('NOT_IMPLEMENTED: Android handler body — see services/release-publisher/src/handlers/android.ts TODO');
}
