import { BrowserConnector, MockBrowserDriver } from '../../src/connectors/browser-connector';
import { JobContext } from '../../src/connectors/connector';
import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { CaptchaEncountered, HumanTaskRequired } from '../../src/guardrails/errors';
import { assertNoPii } from '../../src/guardrails/no-pii-leak';
import { HumanTask } from '../../src/guardrails/human-gate';

const browserPolicy: ProviderPolicy = {
  automation_allowed: 'browser_with_human_submit',
  registration_method: 'human_required',
  captcha_policy: 'human_only',
  kyb_required: false,
  multi_account_allowed: false,
  affiliate_cashback_allowed: null,
  notes: 't',
};

function setup(provider = 'aliexpress') {
  const pe = new PolicyEngine();
  pe.setPolicy(provider, browserPolicy);
  const driver = new MockBrowserDriver(provider);
  const connector = new BrowserConnector(pe, driver);
  const tasks: HumanTask[] = [];
  const ctx: JobContext = { providerId: provider, tenantId: 'platform', accountId: 'acc1', env: { VCAOP_ENV: 'dev' }, emitHumanTask: (t) => tasks.push(t) };
  return { pe, driver, connector, ctx, tasks };
}

describe('CONN-BROWSER-0004 — BrowserConnector', () => {
  test('dry-run operate against a fixture returns ok with isolated profile', async () => {
    const { connector, driver, ctx } = setup();
    const r = await connector.operate({ kind: 'fill_form' }, ctx);
    expect(r.ok).toBe(true);
    expect(driver.seenProfiles).toEqual(['vcaop/aliexpress/acc1']); // isolated per provider+account
  });

  test('CAPTCHA fixture -> CaptchaEncountered (routed to human task, never solved)', async () => {
    const { connector, driver, ctx } = setup();
    driver.nextCaptcha = true;
    await expect(connector.operate({ kind: 'login' }, ctx)).rejects.toBeInstanceOf(CaptchaEncountered);
  });

  test('irreversible submit -> human gate', async () => {
    const { connector, driver, ctx, tasks } = setup();
    driver.nextIrreversible = true;
    await expect(connector.operate({ kind: 'submit_order' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
    expect(tasks.map((t) => t.type)).toContain('IRREVERSIBLE_SUBMIT');
  });

  test('artifacts are scrubbed of PII before returning', async () => {
    const { connector, driver, ctx } = setup();
    driver.artifacts = [
      { kind: 'dom', content: { html: 'user jane@example.com address 1 Main St', officer_name: 'Jane Doe' } },
      { kind: 'screenshot', content: 'contact +14155550123' },
    ];
    const r = await connector.operate({ kind: 'scrape' }, ctx);
    const blob = JSON.stringify(r.data);
    expect(blob).not.toMatch(/jane@example\.com/);
    expect(blob).not.toMatch(/Jane Doe/);
    expect(blob).not.toMatch(/\+14155550123/);
    // and the returned artifacts pass the PII assertion
    expect(() => assertNoPii((r.data as any).artifacts, 'browser_artifact')).not.toThrow();
  });

  test('isolated profiles differ across accounts', async () => {
    const { connector, driver, ctx } = setup();
    await connector.operate({ kind: 'a' }, ctx);
    await connector.operate({ kind: 'b' }, { ...ctx, accountId: 'acc2' });
    expect(new Set(driver.seenProfiles).size).toBe(2);
  });

  test('register is human-gated', async () => {
    const { connector, ctx } = setup();
    await expect(connector.register({ tenantId: 'platform', legalName: 'X', entityType: 'ltd' }, ctx)).rejects.toBeInstanceOf(HumanTaskRequired);
  });

  test('live driver is refused unless explicitly allowed', async () => {
    const pe = new PolicyEngine();
    pe.setPolicy('aliexpress', browserPolicy);
    const driver = new MockBrowserDriver('aliexpress');
    driver.isLive = true;
    const connector = new BrowserConnector(pe, driver); // allowLive defaults false
    const ctx: JobContext = { providerId: 'aliexpress', tenantId: 'platform', accountId: 'a', env: { VCAOP_ENV: 'dev' }, emitHumanTask: () => {} };
    await expect(connector.operate({ kind: 'x' }, ctx)).rejects.toThrow(/live browser automation is disabled/);
  });
});
