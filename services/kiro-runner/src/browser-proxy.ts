/**
 * VTID-05070: the `vitana-browser` MCP server Kiro sees — a stdio relay to the kiro-browser
 * sidecar on localhost (see browser.ts).
 *
 * ONE tool, `browser_screenshot`. The call goes to the sidecar's POST /screenshot with the
 * session's browser token; every guard (staging hosts only, production refused, non-GET
 * aborted except the test user's sign-in, 30 s per page, 10 per run) is enforced in the
 * sidecar and on the gateway, never here. `tools/list` is empty while the sidecar reports
 * no working browser, so Kiro is never offered a tool that cannot run.
 *
 * Reads only KIRO_BROWSER_URL and KIRO_BROWSER_SESSION_TOKEN.
 */
import { createInterface } from 'readline';

export const BROWSER_TOOL = {
  name: 'browser_screenshot',
  title: 'Screenshot a staging page',
  description:
    'Open a page of the Vitana STAGING environment in a headless browser (read-only: it never clicks a button that writes, '
    + 'production hosts are refused) and take a screenshot at desktop (1400x900) and/or mobile (390x844). Optional: wait for a '
    + 'CSS selector, click one selector first (to open a menu, tab or dialog), capture the full page. Optionally signed in as the '
    + 'E2E test user. At most 10 screenshots per run. Returns the stored media id and size of each image.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'https URL on a staging host, e.g. https://preview-aws.vitanaland.com/settings' },
      viewport: { type: 'string', enum: ['desktop', 'mobile', 'both'], default: 'both' },
      full_page: { type: 'boolean', default: false },
      wait_for_selector: { type: 'string', description: 'CSS selector to wait for before the screenshot' },
      click_selector: { type: 'string', description: 'CSS selector to click once before the screenshot (navigation off the staging hosts is blocked)' },
      sign_in: { type: 'boolean', default: false, description: 'Sign in as the E2E test user first (read-only session)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

const INSTRUCTIONS = 'Read-only screenshots of the Vitana staging environment. Screenshot a UI change at desktop and mobile after it is on staging, before asking to publish.';
// Two viewports at 30 s each plus the uploads, under the 120 s ALB idle limit the sidecar's own calls share.
const CALL_TIMEOUT_MS = 100_000;

type FetchLike = typeof fetch;
interface Env { url: string; token: string }

function envOf(e: NodeJS.ProcessEnv = process.env): Env {
  return { url: (e.KIRO_BROWSER_URL ?? '').replace(/\/+$/, ''), token: e.KIRO_BROWSER_SESSION_TOKEN ?? '' };
}

async function browserReady(env: Env, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const r = await fetchImpl(`${env.url}/alive`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return false;
    const b: any = await r.json();
    return b?.browser?.ok === true;
  } catch { return false; }
}

export async function handle(msg: any, fetchImpl: FetchLike = fetch, env: Env = envOf()): Promise<unknown | null> {
  const isNotification = !msg || typeof msg !== 'object' || msg.id === undefined;
  const id = isNotification ? null : msg.id;
  const err = (code: number, message: string) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid Request');
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vitana-browser', title: 'Vitana staging screenshots', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const ok = !!env.url && !!env.token && await browserReady(env, fetchImpl);
      return { jsonrpc: '2.0', id, result: { tools: ok ? [BROWSER_TOOL] : [] } };
    }
    case 'tools/call': {
      if (msg.params?.name !== BROWSER_TOOL.name) return err(-32602, `Unknown tool: ${String(msg.params?.name)}`);
      const text = (t: string, isError: boolean) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }], isError } });
      if (!env.url || !env.token) return text('screenshots are not configured for this session', true);
      try {
        const r = await fetchImpl(`${env.url}/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.token}` },
          body: JSON.stringify(msg.params?.arguments ?? {}),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const body: any = await r.json().catch(() => ({ ok: false, error: `browser answered ${r.status}` }));
        if (!body?.ok) return text(String(body?.error ?? `browser answered ${r.status}`), true);
        return text(JSON.stringify({ images: body.images }), false);
      } catch (e) {
        return text(`browser unreachable: ${e instanceof Error ? e.message : 'error'}`, true);
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return err(-32601, `Method not found: ${msg.method}`);
  }
}

if (require.main === module) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); return; }
    void handle(msg).then((r) => { if (r) process.stdout.write(`${JSON.stringify(r)}\n`); });
  });
  rl.on('close', () => process.exit(0));
}
