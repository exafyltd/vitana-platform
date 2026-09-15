/**
 * VTID-03894 — the affiliate networks a supplier may claim.
 *
 * Adding a network to ATTRIBUTING_NETWORKS is a one-word change that looks
 * harmless and quietly promises attribution this platform cannot deliver: the
 * supplier answers the question, we store the answer, and not one of their
 * sales is ever matched back to them. They would have every reason to believe
 * it was working.
 *
 * So the list is pinned to the networks that have a REAL conversion path, and
 * this test names where each path lives, so a future reader can check the claim
 * rather than trust it:
 *
 *   awin    — PULLED.  creditAwinConversions() in services/awin-conversions.ts
 *                      reads our publisher account's transactions and resolves
 *                      each one by advertiser id.
 *   admitad — PUSHED.  routes/vcaop-postback.ts mounts /admitad and nothing
 *                      else; the network calls us when a purchase settles.
 *
 * CJ, Rakuten, Impact, Partnerize and Tradedoubler have no path in either
 * direction. The frontend picker is pinned to the same two by
 * vitana-v1's src/components/commerce/AffiliateNetwork.test.ts — two repos, so
 * neither test can read the other's source; each pins its own end, and the pair
 * is what stops them drifting apart.
 */
import { ATTRIBUTING_NETWORKS } from '../../src/routes/vcaop-portal-my-products';

describe('the networks a supplier may claim', () => {
  it('is exactly the two with a conversion path', () => {
    // Deliberately an equality assertion, not a `contains`. Widening this list
    // should fail here and be argued for, not slip through as an addition.
    expect([...ATTRIBUTING_NETWORKS].sort()).toEqual(['admitad', 'awin']);
  });

  it('offers no network that would attribute nothing', () => {
    for (const n of ['cj', 'rakuten', 'impact', 'partnerize', 'tradedoubler', 'amazon']) {
      expect(ATTRIBUTING_NETWORKS).not.toContain(n);
    }
  });

  it('admitad still has the postback route this list promises', () => {
    const postback = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/routes/vcaop-postback.ts'),
      'utf8',
    );
    // If the route is ever renamed or removed, admitad stops attributing and
    // must come off the list in the same change.
    expect(postback).toContain("'/admitad'");
  });

  it('awin still has the conversions sync this list promises', () => {
    const conversions = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/services/awin-conversions.ts'),
      'utf8',
    );
    expect(conversions).toContain('export async function creditAwinConversions');
  });
});
