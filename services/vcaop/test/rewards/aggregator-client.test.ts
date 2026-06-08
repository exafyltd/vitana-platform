import { HttpAggregatorClient, verifyAggregatorPostbackSignature } from '../../src/rewards/providers/aggregator-client';
import { AffiliateAggregator } from '../../src/rewards/aggregator';
import { mintSubId } from '../../src/agents/monetization';

describe('HttpAggregatorClient scaffold (mock-to-interface; BLK-005)', () => {
  test('mock decorate carries publisher id + per-user SubID', () => {
    const client = new HttpAggregatorClient({ network: 'skimlinks', publisherId: 'pub_42' });
    const agg = new AffiliateAggregator(client);
    const d = agg.decorate('https://shop.example/p/1', 'shop.example', 'u1', 'progX');
    expect(d.subId).toBe(mintSubId('u1', 'progX'));
    expect(d.url).toContain('pub=pub_42');
    expect(d.url).toContain(`subid=${d.subId}`);
    expect(d.url).toContain(encodeURIComponent('https://shop.example/p/1'));
  });

  test('live mode refuses without vaulted creds (no silent live calls)', () => {
    const client = new HttpAggregatorClient({ live: true }); // no apiKeyRef/publisherId
    expect(() => client.decorateLink('https://x.example', 'sub_1')).toThrow(/apiKeyRef/);
  });

  test('postback signature verify is mock-true in dev, refuses in live until wired', () => {
    expect(verifyAggregatorPostbackSignature({}, 'sig')).toBe(true);
    expect(() => verifyAggregatorPostbackSignature({}, 'sig', { live: true })).toThrow(/BLK-005/);
  });
});
