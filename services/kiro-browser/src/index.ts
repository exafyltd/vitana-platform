/**
 * VTID-05070: kiro-browser entry point. 127.0.0.1:8090 (KIRO_BROWSER_PORT), health on /alive.
 *
 * Chromium is launched SANDBOX-FIRST (chromiumSandbox: true). Whether Fargate allows the
 * sandbox is proven on the first staging deploy: /alive reports {browser: {ok, sandbox,
 * error}}. If the sandbox cannot start there, KIRO_BROWSER_NO_SANDBOX=true (set in the task
 * definition by AWS-STAGE-DEPLOY-KIRO-RUNNER.yml's `browser_no_sandbox` input) launches
 * without it — ONLY in this dedicated container, which holds no secret other than the test
 * user's password and reaches only the allowlisted hosts. It is never set silently: the
 * fallback is an explicit flag, logged at start and reported on /alive.
 */
import { chromium, type Browser } from 'playwright-core';
import { createBrowserServer, type BrowserStatus } from './server';
import { GatewayClient } from './gateway';
import { hostResolverRules, stagingHosts } from './guard';
import { SignIn, signInConfigFromEnv } from './auth';
import type { BrowserLike } from './shooter';

function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const registryToken = process.env.KIRO_BROWSER_REGISTRY_TOKEN ?? '';
const gatewayUrl = process.env.KIRO_MEDIA_GATEWAY_URL ?? '';
if (registryToken.length < 16 || !/^https:\/\//.test(gatewayUrl)) {
  console.error('[kiro-browser] KIRO_BROWSER_REGISTRY_TOKEN and an https KIRO_MEDIA_GATEWAY_URL are required');
  process.exit(1);
}

const noSandbox = process.env.KIRO_BROWSER_NO_SANDBOX === 'true';
const status: BrowserStatus = { ok: false, sandbox: !noSandbox, error: 'starting' };
let browser: Browser | null = null;

async function launch(): Promise<void> {
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: !noSandbox,
      args: ['--disable-dev-shm-usage', `--host-resolver-rules=${hostResolverRules()}`],
    });
    status.ok = true;
    status.error = null;
    status.chromium = browser.version();
    console.log(`[kiro-browser] chromium ${browser.version()} started (sandbox ${noSandbox ? 'OFF by KIRO_BROWSER_NO_SANDBOX' : 'on'})`);
    browser.on('disconnected', () => {
      browser = null;
      status.ok = false;
      status.error = 'chromium disconnected; restarting';
      setTimeout(() => void launch(), 5_000).unref();
    });
  } catch (e) {
    browser = null;
    status.ok = false;
    status.error = `chromium did not start${noSandbox ? '' : ' with the sandbox'}: ${e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : 'error'}`;
    console.error(`[kiro-browser] ${status.error}`);
    setTimeout(() => void launch(), 60_000).unref();
  }
}

const signInCfg = signInConfigFromEnv();
const signIn = signInCfg ? new SignIn(signInCfg) : null;
const hosts = stagingHosts();
const server = createBrowserServer({
  registryToken,
  gateway: new GatewayClient(gatewayUrl),
  hosts,
  browser: () => browser as unknown as BrowserLike | null,
  status: () => ({ ...status }),
  signIn: signIn ? () => signIn.storage() : null,
  pageTimeoutMs: intEnv('KIRO_BROWSER_PAGE_TIMEOUT_MS', 30_000),
});

const port = intEnv('KIRO_BROWSER_PORT', 8090);
server.listen(port, '127.0.0.1', () => {
  console.log(`[kiro-browser] listening on 127.0.0.1:${port}; staging hosts: ${[...hosts].join(', ')}; sign-in ${signIn ? 'configured' : 'off'}`);
  void launch();
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(); void browser?.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); });
}
