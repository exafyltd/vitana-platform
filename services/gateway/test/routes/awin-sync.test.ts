/**
 * Unit tests for the Awin programme sync mapping + config resolution
 * (behind POST /api/v1/vcaop/awin/sync and the background worker).
 */
import {
  mapAwinProgramme,
  resolveAwinConfig,
  type AwinSyncConfig,
  type AwinProgramme,
} from '../../src/services/awin-sync';

const cfg: AwinSyncConfig = {
  publisherId: '2938137',
  apiToken: 'tok',
  apiBase: 'https://api.awin.com',
};

describe('mapAwinProgramme', () => {
  const prog: AwinProgramme = {
    id: 122456,
    name: 'ROCKBROS',
    primarySector: 'Sports Equipment',
    currencyCode: 'EUR',
    status: 'Active',
    primaryRegion: { countryCode: 'DE' },
  };

  test('maps to an affiliate_program row with the Awin deeplink + clickref', () => {
    const row = mapAwinProgramme(prog, cfg)!;
    expect(row.id).toBe('awin_122456');
    expect(row.network).toBe('awin');
    expect(row.merchant).toBe('ROCKBROS');
    expect(row.affiliate_cashback_allowed).toBe(true);
    expect(row.source).toBe('aggregator');
    const policy = row.policy as Record<string, unknown>;
    expect(policy.gotolink).toBe('https://www.awin1.com/cread.php?awinmid=122456&awinaffid=2938137');
    expect(policy.subid_param).toBe('clickref');
    expect(policy.deeplink_param).toBe('ued');
    const terms = row.commission_terms as Record<string, unknown>;
    expect(terms.awin_mid).toBe('122456');
    expect(terms.market).toBe('DE');
  });

  test('deterministic id is stable across syncs (idempotent upsert key)', () => {
    expect(mapAwinProgramme(prog, cfg)!.id).toBe(mapAwinProgramme(prog, cfg)!.id);
  });

  test('returns null for an invalid programme (no id/name)', () => {
    expect(mapAwinProgramme({ id: 0, name: '' } as AwinProgramme, cfg)).toBeNull();
  });

  test('tolerates missing optional fields', () => {
    const row = mapAwinProgramme({ id: 999, name: 'X' } as AwinProgramme, cfg)!;
    expect(row.id).toBe('awin_999');
    expect((row.commission_terms as Record<string, unknown>).market).toBeNull();
  });
});

describe('resolveAwinConfig', () => {
  const OLD_ID = process.env.AWIN_PUBLISHER_ID;
  const OLD_TOK = process.env.AWIN_API_TOKEN;
  afterAll(() => {
    if (OLD_ID === undefined) delete process.env.AWIN_PUBLISHER_ID; else process.env.AWIN_PUBLISHER_ID = OLD_ID;
    if (OLD_TOK === undefined) delete process.env.AWIN_API_TOKEN; else process.env.AWIN_API_TOKEN = OLD_TOK;
  });

  test('null when publisher id or token is missing', () => {
    delete process.env.AWIN_PUBLISHER_ID;
    delete process.env.AWIN_API_TOKEN;
    expect(resolveAwinConfig()).toBeNull();
    process.env.AWIN_PUBLISHER_ID = '2938137';
    expect(resolveAwinConfig()).toBeNull(); // still no token
  });

  test('builds config when both are set', () => {
    process.env.AWIN_PUBLISHER_ID = '2938137';
    process.env.AWIN_API_TOKEN = 'abc';
    const c = resolveAwinConfig()!;
    expect(c.publisherId).toBe('2938137');
    expect(c.apiBase).toBe('https://api.awin.com');
  });
});
