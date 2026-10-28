/**
 * VTID-03507 — Appilix suppression when a phone changes hands.
 *
 * Regression cover for the duplicate lock-screen notification: one post
 * arriving twice on one phone, once per account that had ever signed in on it,
 * each in that account's language ("New post" + "Neuer Beitrag").
 *
 * The VTID-03481 gate (`isSignedOutOnAllKnownDevices`) only fired for a user
 * signed out on EVERY device, which missed the case that was actually
 * happening in production: the previous owner stayed signed in on their laptop,
 * so the gate said "still signed in", and Appilix — which addresses devices by
 * user_identity and keeps identity→device mappings we cannot purge — carried on
 * delivering their copy to a phone that now belonged to someone else.
 */
import {
  hasLostDeviceToAnotherAccount,
  isSignedOutOnAllKnownDevices,
} from '../../src/services/notification-service';

type Row = { fcm_token: string; device_label: string | null; revoked_at: string | null };

const REVOKED = '2026-08-03T20:21:22.000Z';

/** Labels as they actually appear in user_device_tokens. */
const NATIVE_TAGGED = 'Appilix Mozilla/5.0 (Linux; Android; K) App10 AppleWebKit/537.36';
const NATIVE_UNTAGGED = 'Mozilla/5.0 (Linux; Android; K) App10 AppleWebKit/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0';

/**
 * Minimal Supabase stub. `ownRows` answers the caller's own-rows query; the
 * second, chained query (same token held live by anyone else) is answered from
 * `otherLiveTokens`.
 */
function makeSupabase(ownRows: Row[] | null, otherLiveTokens: string[] = [], opts: {
  ownError?: boolean;
  othersError?: boolean;
} = {}) {
  let call = 0;
  return {
    from() {
      call += 1;
      const isOwnQuery = call === 1;
      const builder: any = {
        _tokens: [] as string[],
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        is() { return builder; },
        in(_col: string, tokens: string[]) { builder._tokens = tokens; return builder; },
        limit() { return builder; },
        then(resolve: (v: any) => void) {
          if (isOwnQuery) {
            return resolve(
              opts.ownError
                ? { data: null, error: { message: 'boom' } }
                : { data: ownRows, error: null },
            );
          }
          if (opts.othersError) return resolve({ data: null, error: { message: 'boom' } });
          const hits = builder._tokens.filter((t: string) => otherLiveTokens.includes(t));
          return resolve({ data: hits.map((fcm_token: string) => ({ fcm_token })), error: null });
        },
      };
      return builder;
    },
  } as any;
}

describe('hasLostDeviceToAnotherAccount (VTID-03507)', () => {
  it('suppresses the account that lost the phone but is still signed in on desktop', async () => {
    // The exact production shape: same Android token live for the new owner,
    // revoked for the previous one, who still holds a live Windows claim.
    const supa = makeSupabase(
      [
        { fcm_token: 'androidTok', device_label: NATIVE_UNTAGGED, revoked_at: REVOKED },
        { fcm_token: 'desktopTok', device_label: DESKTOP, revoked_at: null },
      ],
      ['androidTok'],
    );
    await expect(hasLostDeviceToAnotherAccount('prev-owner', supa)).resolves.toBe(true);
  });

  it('does NOT suppress the current owner of the phone', async () => {
    const supa = makeSupabase(
      [{ fcm_token: 'androidTok', device_label: NATIVE_TAGGED, revoked_at: null }],
      [],
    );
    await expect(hasLostDeviceToAnotherAccount('new-owner', supa)).resolves.toBe(false);
  });

  it('does NOT suppress when a claim lapsed but nobody else took the device', async () => {
    const supa = makeSupabase(
      [
        { fcm_token: 'androidTok', device_label: NATIVE_UNTAGGED, revoked_at: REVOKED },
        { fcm_token: 'desktopTok', device_label: DESKTOP, revoked_at: null },
      ],
      [], // no other account holds it live
    );
    await expect(hasLostDeviceToAnotherAccount('lapsed', supa)).resolves.toBe(false);
  });

  it('does NOT suppress a user who still has another live native device', async () => {
    const supa = makeSupabase(
      [
        { fcm_token: 'oldPhone', device_label: NATIVE_UNTAGGED, revoked_at: REVOKED },
        { fcm_token: 'newPhone', device_label: NATIVE_TAGGED, revoked_at: null },
      ],
      ['oldPhone'],
    );
    await expect(hasLostDeviceToAnotherAccount('two-phones', supa)).resolves.toBe(false);
  });

  it('ignores a lost DESKTOP claim — Appilix cannot reach a browser anyway', async () => {
    const supa = makeSupabase(
      [{ fcm_token: 'desktopTok', device_label: DESKTOP, revoked_at: REVOKED }],
      ['desktopTok'],
    );
    await expect(hasLostDeviceToAnotherAccount('desktop-only', supa)).resolves.toBe(false);
  });

  it('does not mistake "AppleWebKit" for an app-shell build tag', async () => {
    // The native heuristic is /appilix|\bApp\d+\b/i — "AppleWebKit" has no
    // digits after "App", so a plain browser UA must not read as native.
    const supa = makeSupabase(
      [{ fcm_token: 'browserTok', device_label: DESKTOP, revoked_at: REVOKED }],
      ['browserTok'],
    );
    await expect(hasLostDeviceToAnotherAccount('browser', supa)).resolves.toBe(false);
  });

  it('fails OPEN when the user has no device rows at all (legacy iOS shell)', async () => {
    await expect(hasLostDeviceToAnotherAccount('no-rows', makeSupabase([]))).resolves.toBe(false);
  });

  it('fails OPEN on a query error — a missed notification beats a duplicate', async () => {
    const own = makeSupabase(null, [], { ownError: true });
    await expect(hasLostDeviceToAnotherAccount('err', own)).resolves.toBe(false);

    const others = makeSupabase(
      [{ fcm_token: 'androidTok', device_label: NATIVE_UNTAGGED, revoked_at: REVOKED }],
      ['androidTok'],
      { othersError: true },
    );
    await expect(hasLostDeviceToAnotherAccount('err2', others)).resolves.toBe(false);
  });
});

describe('isSignedOutOnAllKnownDevices (VTID-03481) still holds', () => {
  it('suppresses when every claim is revoked', async () => {
    const supa = makeSupabase([
      { fcm_token: 'a', device_label: NATIVE_TAGGED, revoked_at: REVOKED },
      { fcm_token: 'b', device_label: DESKTOP, revoked_at: REVOKED },
    ]);
    await expect(isSignedOutOnAllKnownDevices('gone', supa)).resolves.toBe(true);
  });

  it('does not suppress while any claim is live — this is the gap 03507 covers', async () => {
    const supa = makeSupabase([
      { fcm_token: 'a', device_label: NATIVE_UNTAGGED, revoked_at: REVOKED },
      { fcm_token: 'b', device_label: DESKTOP, revoked_at: null },
    ]);
    await expect(isSignedOutOnAllKnownDevices('prev-owner', supa)).resolves.toBe(false);
  });
});
