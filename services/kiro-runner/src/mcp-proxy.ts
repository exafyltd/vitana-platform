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

export async function forward(line: string, fetchImpl: typeof fetch = fetch): Promise<unknown | null> {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
  const id = msg && typeof msg === 'object' && 'id' in msg ? msg.id : undefined;
  const fail = (message: string) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32603, message } });
  if (!url || !token) return fail('vitana tools are not configured for this session');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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

if (require.main === module) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void forward(line).then((out) => { if (out) write(out); });
  });
  rl.on('close', () => process.exit(0));
}
