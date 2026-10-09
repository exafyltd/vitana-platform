#!/usr/bin/env node
// VTID-04999 test double for `kiro-cli acp`: answers initialize/session/new/session/prompt,
// reports its cwd and env so the tests can check what the relay gave it.
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (!process.env.KIRO_API_KEY || process.env.KIRO_API_KEY === 'not-logged-in') { process.stdout.write('Error: You are not logged in\n'); process.exit(1); }
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S1', echo_cwd: m.params.cwd, echo_mcp: m.params.mcpServers, proc_cwd: process.cwd(), env_keys: Object.keys(process.env).sort(), key: process.env.KIRO_API_KEY } });
    else if (m.method === 'session/prompt') {
      if (m.params.prompt[0].text === 'flood') { process.stdout.write('{"x":"' + 'a'.repeat(2 * 1024 * 1024)); return; }
      if (m.params.prompt[0].text === 'bigline') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { t: 'a'.repeat(2 * 1024 * 1024) } }) + '\n'); return; }
      if (m.params.prompt[0].text === 'utf8') {
        // One message whose "é" (0xC3 0xA9) is split across two stdout writes.
        const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', text: 'café ünïcode' } }) + '\n');
        const cut = bytes.indexOf(0xc3) + 1;
        process.stdout.write(bytes.subarray(0, cut));
        setTimeout(() => process.stdout.write(bytes.subarray(cut)), 30);
        return;
      }
      process.stdout.write('not json noise\n');
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
  }
});
