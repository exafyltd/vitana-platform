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
    else if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'S1', echo_cwd: m.params.cwd, proc_cwd: process.cwd(), env_keys: Object.keys(process.env).sort(), key: process.env.KIRO_API_KEY } });
    else if (m.method === 'session/prompt') {
      if (m.params.prompt[0].text === 'flood') { process.stdout.write('{"x":"' + 'a'.repeat(2 * 1024 * 1024)); return; }
      process.stdout.write('not json noise\n');
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
  }
});
