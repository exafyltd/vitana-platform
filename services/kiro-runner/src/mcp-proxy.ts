/**
 * VTID-05005: the `vitana` MCP server Kiro sees — a stdio relay.
 *
 * kiro-cli starts this as a stdio MCP server (the runner injects it into every
 * session/new and session/load; see relay.ts). Each newline-delimited JSON-RPC
 * message from Kiro is POSTed to the gateway's /api/v1/operator/kiro/mcp with
 * the session's pass; the gateway's answer is written back as one line.
 * Notifications (no id) get no answer. It holds no other credential and reads
 * only VITANA_MCP_URL and VITANA_MCP_TOKEN.
 */
import { createInterface } from 'readline';

const url = process.env.VITANA_MCP_URL ?? '';
const token = process.env.VITANA_MCP_TOKEN ?? '';
// Over the gateway's 100 s per-tool budget, under the ALB's 120 s idle timeout.
const TIMEOUT_MS = 115_000;

function write(msg: unknown): void { process.stdout.write(`${JSON.stringify(msg)}\n`); }

export async function forward(line: string, fetchImpl: typeof fetch = fetch, cancel?: AbortSignal): Promise<unknown | null> {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
  const id = msg && typeof msg === 'object' && 'id' in msg ? msg.id : undefined;
  const fail = (message: string) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32603, message } });
  if (!url || !token) return fail('vitana tools are not configured for this session');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  // VTID-05006: Kiro abandoning the call aborts it, so a held write is closed on the gateway too.
  cancel?.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: line,
      signal: ctl.signal,
    });
    if (res.status === 202 || id === undefined) return null;
    const text = await res.text();
    try { return JSON.parse(text); } catch { return fail(`vitana tools answered ${res.status}`); }
  } catch (e) {
    return fail(`vitana tools unreachable: ${e instanceof Error ? e.message : 'error'}`);
  } finally {
    clearTimeout(timer);
  }
}

/** In-flight calls by JSON-RPC id, so `notifications/cancelled` can abort the right one. */
export const inFlight = new Map<string, AbortController>();

/** MCP cancellation from Kiro: abort the matching in-flight call. Returns true when it was one. */
export function handleCancel(line: string): boolean {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return false; }
  if (!msg || msg.method !== 'notifications/cancelled') return false;
  const ctl = inFlight.get(String(msg.params?.requestId));
  ctl?.abort();
  return true;
}

export function dispatch(line: string, out: (m: unknown) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (handleCancel(line)) return Promise.resolve();
  let id: string | null = null;
  try { const m = JSON.parse(line); if (m && m.id !== undefined && m.id !== null) id = String(m.id); } catch { /* forward() answers */ }
  const ctl = new AbortController();
  if (id !== null) inFlight.set(id, ctl);
  return forward(line, fetchImpl, ctl.signal).then((r) => { if (r) out(r); }).finally(() => { if (id !== null) inFlight.delete(id); });
}

if (require.main === module) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void dispatch(line, write);
  });
  rl.on('close', () => process.exit(0));
}
