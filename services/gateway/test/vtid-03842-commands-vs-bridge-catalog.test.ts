/**
 * VTID-03842 — the gateway registry must agree with the erp-bridge catalog
 * (services/erp-bridge/app/catalog.py, VTID-03840) on action, tier,
 * capabilities and company scope. Skips when the bridge tree is not checked
 * out alongside (the two ship in separate PRs).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BACKOFFICE_COMMANDS } from '../src/constants/backoffice-commands';

const CATALOG = path.resolve(__dirname, '../../erp-bridge/app/catalog.py');

(fs.existsSync(CATALOG) ? describe : describe.skip)('registry ↔ bridge catalog', () => {
  test('same action set, same tier, capabilities, domain and company scope', () => {
    const src = fs.readFileSync(CATALOG, 'utf8');
    const body = src.slice(src.indexOf('_SPECS: list[ActionSpec] = ['));
    const re = /_a\("([^"]+)", "([^"]+)", "([^"]+)", (\("[^)]*"\)|"[^"]+"), "([^"]+)"([^\n]*)/g;
    const bridge = new Map<string, { tier: string; caps: string[]; company: boolean; domain: string }>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      bridge.set(m[1], { tier: m[3], caps: [...m[4].matchAll(/"([^"]+)"/g)].map((x) => x[1]), company: !m[6].includes('company_scoped=False'), domain: m[5] });
    }
    expect(bridge.size).toBe(BACKOFFICE_COMMANDS.length);
    for (const c of BACKOFFICE_COMMANDS) {
      const b = bridge.get(c.action);
      expect(b).toBeDefined();
      expect({ action: c.action, tier: c.tier, caps: [...c.capabilities], company: c.companyScoped, domain: c.domain })
        .toEqual({ action: c.action, tier: b!.tier, caps: b!.caps, company: b!.company, domain: b!.domain });
    }
  });
});
