#!/usr/bin/env node
// VTID-05280 evidence checker (read-only). Run from the repository root:
//   node docs/validation/VTID-05280/check.mjs tokens|labels|lines|xref
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const md = readFileSync('CLAUDE.md', 'utf8');
const lines = md.split('\n');
const mode = process.argv[2];

const TOKENS = ['inmkhvwdcuyhnxkgfvsb', 'notification_test_actors', 'service_bot_accounts', "provider: 'bedrock'",
  'BEDROCK_ROLE_ARN', 'VERTEX_SERBIAN_BRIDGE_ENABLED', 'AUDIOBOOK_GOOGLE_RU_ENABLED', '472838866351', '/alive', '8080',
  'converged-auto-v1', 'STAGING-VERIFY', 'expected_commit', 'build-info', 'isAutonomousExecutionTask',
  'EXECUTION_DISARMED', 'X-BYPASS-ORCHESTRATOR', 'test:support', 'test:operator', 'test:roles', 'persona-voice-gender',
  'a27552a3-0257-4305-8ed0-351a80fd3701'];

function labels() {
  const p1 = lines.findIndex((l) => l.startsWith('# PART 1'));
  const p2 = lines.findIndex((l) => l.startsWith('# PART 2'));
  const inv = {}; const dups = []; let sec = null;
  for (let i = p1; i < p2; i++) {
    const l = lines[i];
    if (/^## /.test(l)) { sec = /ALWAYS/.test(l) ? 'ALWAYS' : /NEVER/.test(l) ? 'NEVER' : /IF–THEN/.test(l) ? 'IF–THEN' : null; if (sec) inv[sec] = inv[sec] || new Set(); continue; }
    const m = l.match(/^(\d+[a-h]?)\. /) || l.match(/^- (AI-\d+)\. /);
    if (!m || !sec) continue;
    if (inv[sec].has(m[1])) dups.push(`${sec} ${m[1]}`);
    inv[sec].add(m[1]);
  }
  const idx = lines.slice(lines.findIndex((l) => l.startsWith('### Retired-number index')), p2).join('\n');
  return { inv, dups, idx };
}

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p)); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

if (mode === 'tokens') {
  const missing = TOKENS.filter((t) => !md.includes(t));
  console.log(missing.length ? `FAIL missing: ${missing.join(', ')}` : `PASS ${TOKENS.length}/${TOKENS.length} tokens present`);
  process.exit(missing.length ? 1 : 0);
}
if (mode === 'labels') {
  const { dups } = labels();
  console.log(dups.length ? `FAIL duplicates: ${dups.join(', ')}` : 'PASS no Part 1 label used twice within a section');
  process.exit(dups.length ? 1 : 0);
}
if (mode === 'lines') {
  for (const f of ['CLAUDE.md', '.kiro/steering/vitana-kiro-notes.md', '.kiro/steering/vitana-load-project-rules.md']) {
    const n = readFileSync(f, 'utf8').replace(/\n$/, '').split('\n').length;
    console.log(`${f} ${n}`);
  }
  process.exit(0);
}
if (mode === 'xref') {
  // Every ALWAYS/NEVER/IF-THEN label cited in a loaded rules file must resolve to a kept label,
  // the AI-n alias or a row of the retired-number index.
  const { inv, idx } = labels();
  const bad = [];
  for (const f of [...walk('.claude/rules'), ...walk('.kiro/steering')]) {
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/(ALWAYS|NEVER|IF.?THEN)\s*(?:rules?\s*)?(\d+[a-h]?)/g)) {
      const sec = m[1].startsWith('IF') ? 'IF–THEN' : m[1];
      const n = m[2];
      const ok = inv[sec]?.has(n) || (sec === 'IF–THEN' && inv['IF–THEN']?.has(`AI-${n}`))
        || new RegExp(`${sec}[^|]*\\b${n}\\b`).test(idx);
      if (!ok) bad.push(`${f}: ${m[0]}`);
    }
  }
  console.log(bad.length ? `FAIL unresolved: ${bad.join('; ')}` : 'PASS every label cited in .claude/rules/** and .kiro/steering/** resolves');
  process.exit(bad.length ? 1 : 0);
}
console.error('usage: check.mjs tokens|labels|lines|xref');
process.exit(2);
