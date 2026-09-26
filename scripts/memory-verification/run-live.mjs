#!/usr/bin/env node
/**
 * VTID-04600 — memory verification suite, layer B (live voice on STAGING).
 *
 * For every scenario in scenarios.live.json it speaks the member's lines to
 * the deployed ORB on staging (Polly-synthesized German/English PCM, cached),
 * then checks three things:
 *   1. what is stored — the member's current facts, read through the Memory
 *      Garden API (the product's own read path);
 *   2. what Vitana said — keyword rules on the reply transcript;
 *   3. across sessions — a fact said in one session is asked in the next.
 * Each scenario runs --runs times (default 2); it passes only if every run
 * passes, so one lucky run cannot hide the voice model's non-determinism.
 *
 * Safety:
 *   - refuses to start unless the gateway reports env=staging;
 *   - acts only as the test user whose token it is given;
 *   - before each scenario it removes facts this run created (Garden delete),
 *     never touching facts that existed before the run started;
 *   - it produces no community content;
 *   - at the end it prints the SQL that purges the test user's own rows
 *     written since the run began (transcripts, notes, forget markers).
 *
 * usage:
 *   MEMORY_VERIFY_TOKEN=<test user JWT> node scripts/memory-verification/run-live.mjs \
 *     [--only B-CONF-02,B-REC-01] [--runs 2] [--out <dir>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = process.env.MEMORY_VERIFY_GATEWAY || 'https://preview-aws-gateway.vitanaland.com';
const ORIGIN = process.env.MEMORY_VERIFY_ORIGIN || 'https://preview-aws.vitanaland.com';
const TOKEN = process.env.MEMORY_VERIFY_TOKEN;
const TEST_USER = 'a27552a3-0257-4305-8ed0-351a80fd3701';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ONLY = opt('only', '') ? opt('only', '').split(',') : null;
const RUNS = Number(opt('runs', '2'));
const OUT = opt('out', join(HERE, 'out', new Date().toISOString().replace(/[:.]/g, '-')));
const CACHE = join(HERE, 'out', 'audio-cache');
const SETTLE_MS = Number(process.env.MEMORY_VERIFY_SETTLE_MS || 12000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` });

// ---------------------------------------------------------------- guards
async function guard() {
  if (!TOKEN) throw new Error('MEMORY_VERIFY_TOKEN (the test user JWT) is required');
  const payload = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString());
  if (payload.sub !== TEST_USER) throw new Error(`token is not the test user (${payload.sub})`);
  const h = await (await fetch(`${GATEWAY}/api/v1/admin/health`)).json();
  if (h.env !== 'staging') throw new Error(`gateway reports env=${h.env}; this runner only runs against staging`);
  const b = await (await fetch(`${GATEWAY}/api/v1/admin/build-info`)).json().catch(() => ({}));
  return { env: h.env, commit: b.git_commit ?? null };
}

// ---------------------------------------------------------------- speech
const VOICE = { de: 'Vicki', en: 'Joanna' };
function speech(text, lang) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, createHash('sha1').update(`${lang}|${text}`).digest('hex') + '.raw');
  if (!existsSync(file)) {
    execFileSync('aws', ['polly', 'synthesize-speech', '--region', 'eu-central-1', '--engine', 'neural',
      '--voice-id', VOICE[lang] || VOICE.de, '--output-format', 'pcm', '--sample-rate', '16000',
      '--text', text, file], { stdio: 'ignore' });
  }
  return readFileSync(file);
}

// ---------------------------------------------------------------- one voice session
async function runSession(lang, utterances) {
  const log = { lang, started: new Date().toISOString(), replies: utterances.map(() => ''), heard: utterances.map(() => ''), events: {} };
  const start = await fetch(`${GATEWAY}/api/v1/orb/live/session/start`, { method: 'POST', headers: headers(), body: JSON.stringify({ lang }) });
  const sb = await start.json().catch(() => ({}));
  if (!sb.ok) return { ...log, error: `start ${start.status}` };
  log.session_id = sb.session_id;
  fetch(`${GATEWAY}/api/v1/orb/session/${sb.session_id}/audio-ready`, { method: 'POST', headers: headers(), body: '{}' }).catch(() => {});
  const sse = await fetch(`${GATEWAY}/api/v1/orb/live/stream?session_id=${sb.session_id}&token=${encodeURIComponent(TOKEN)}`,
    { headers: { Accept: 'text/event-stream', Origin: ORIGIN, Authorization: `Bearer ${TOKEN}` } });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let sent = -1; // index of the last utterance sent; -1 = still in the greeting
  let lastActivity = Date.now();
  let turnDoneAt = 0;
  let sending = null;
  const deadline = Date.now() + 60000 + utterances.length * 45000;

  const send = async (pcm) => {
    const stream = Buffer.concat([pcm, Buffer.alloc(32000 * 2)]); // 2 s of silence ends the turn
    for (let off = 0; off < stream.length; off += 3200) {
      await fetch(`${GATEWAY}/api/v1/orb/live/stream/send`, { method: 'POST', headers: headers(),
        body: JSON.stringify({ session_id: sb.session_id, type: 'audio', data_b64: stream.subarray(off, off + 3200).toString('base64'), mime: 'audio/pcm;rate=16000' }) })
        .catch(() => { log.sendErrors = (log.sendErrors || 0) + 1; });
      await sleep(100);
    }
  };

  let pendingRead = reader.read();
  while (Date.now() < deadline) {
    const r = await Promise.race([pendingRead, sleep(500).then(() => ({ tick: true }))]);
    if (!r.tick) {
      if (r.done) break;
      pendingRead = reader.read();
      buf += dec.decode(r.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        let m;
        try { m = JSON.parse(data); } catch { continue; }
        const t = m.type || '?';
        log.events[t] = (log.events[t] || 0) + 1;
        if ((t === 'transcript' || t === 'output_transcript') && m.text) {
          if (sent >= 0) log.replies[sent] += m.text;
          lastActivity = Date.now();
        }
        if (t === 'input_transcript' && m.text && sent >= 0) log.heard[sent] += m.text;
        if (t === 'error') log.error = m.message || m.code || 'error';
        if (t === 'turn_complete') turnDoneAt = Date.now();
      }
    }
    // Send the next line once the assistant has finished and stayed quiet for
    // 4 s — a gateway note can trigger a second reply to the same line.
    const quiet = turnDoneAt && Date.now() - Math.max(turnDoneAt, lastActivity) > 4000;
    if (quiet && !sending) {
      if (sent + 1 >= utterances.length) break;
      sent++;
      turnDoneAt = 0;
      sending = send(utterances[sent]).finally(() => { sending = null; });
    }
  }
  if (sending) await sending.catch(() => {});
  reader.cancel().catch(() => {});
  await fetch(`${GATEWAY}/api/v1/orb/live/session/stop`, { method: 'POST', headers: headers(), body: JSON.stringify({ session_id: sb.session_id }) }).catch(() => {});
  log.ended = new Date().toISOString();
  log.completed_all = sent === utterances.length - 1;
  return log;
}

// ---------------------------------------------------------------- Garden (read/seed/cleanup)
async function gardenFacts() {
  const r = await fetch(`${GATEWAY}/api/v1/memory/garden/entries?limit=500`, { headers: headers() });
  const j = await r.json();
  if (!j.ok) throw new Error(`garden list failed: ${JSON.stringify(j)}`);
  return j.entries.filter((e) => e.kind === 'fact');
}
async function gardenAdd(key, value) {
  const r = await fetch(`${GATEWAY}/api/v1/memory/garden/entries`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'fact', fact_key: key, fact_value: value }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`seed ${key} failed: ${JSON.stringify(j)}`);
}
async function gardenDelete(id) {
  await fetch(`${GATEWAY}/api/v1/memory/garden/entries/fact/${id}`, { method: 'DELETE', headers: headers() });
}

// Keys the gateway writes on its own during any session (not what a scenario
// tests). They are never deleted — a Garden delete records a "forgotten"
// marker, which would stop the gateway writing them again — and never judged.
const SYSTEM_KEY = /^(preferred_language|stt_language|user_timezone|timezone|locale)$/i;
// A Garden delete removes every row of that key, so a key the account held
// before the run is never deleted (that would erase the baseline too).
let baselineKeys = new Set();
// Values removed by cleanup during this invocation. Each left a "forgotten"
// marker; a later scenario that expects the same value to be written (or not)
// by an inferred write would be decided by the marker, not by the code under
// test. Such results are reported as confounded, never as pass or fail.
const deletedValues = [];
async function cleanupSuiteFacts(baselineIds) {
  for (const f of await gardenFacts()) {
    if (baselineIds.has(f.id) || SYSTEM_KEY.test(f.fact_key)) continue;
    if (baselineKeys.has(f.fact_key)) {
      console.warn(`  ! ${f.fact_key} is a baseline key — left in place, restore by hand: ${f.content}`);
      continue;
    }
    deletedValues.push(f.content);
    await gardenDelete(f.id);
  }
}

// ---------------------------------------------------------------- matching (mirrors remember-fact-tool.ts)
const MONTHS = { jan: 1, january: 1, januar: 1, feb: 2, february: 2, februar: 2, mar: 3, march: 3, märz: 3, maerz: 3, apr: 4, april: 4, may: 5, mai: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12, dez: 12, dezember: 12 };
function normalizeDate(value) {
  const v = String(value).trim().toLowerCase();
  let m = v.match(/^--(\d{1,2})-(\d{1,2})$/);
  if (m) return `--${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  let day = null, month = null, year = null;
  for (const t of v.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)) {
    const n = t.replace(/(st|nd|rd|th)$/, '');
    if (MONTHS[t] !== undefined) month = MONTHS[t];
    else if (/^\d{4}$/.test(n)) year = Number(n);
    else if (/^\d{1,2}$/.test(n) && day === null) day = Number(n);
  }
  if (day === null || month === null) return null;
  const mm = String(month).padStart(2, '0'), dd = String(day).padStart(2, '0');
  return year ? `${year}-${mm}-${dd}` : `--${mm}-${dd}`;
}
function valuesMatch(a, b) {
  if (String(b).includes('%')) return keyLike(String(b), String(a));
  const da = normalizeDate(a), db = normalizeDate(b);
  if (da && db) return da.startsWith('--') || db.startsWith('--') ? da.slice(-5) === db.slice(-5) : da === db;
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(a) === norm(b) || norm(a).includes(norm(b));
}
function keyLike(pattern, key) {
  return pattern.split('|').some((p) => new RegExp('^' + p.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(key));
}

// ---------------------------------------------------------------- one scenario run
async function runScenario(sc, baselineIds, runNo) {
  const out = { id: sc.id, run: runNo, failures: [], sessions: [] };
  // Clean slate: remove facts this suite created earlier (never the baseline).
  await cleanupSuiteFacts(baselineIds);
  const priorDeleted = deletedValues.slice();
  for (const s of sc.seed_facts || []) await gardenAdd(s.key, s.value);

  for (const sess of sc.sessions) {
    if (sess.garden_forget) {
      for (const f of await gardenFacts()) if (keyLike(sess.garden_forget, f.fact_key)) { deletedValues.push(f.content); await gardenDelete(f.id); }
    }
    const pcm = sess.turns.map((t) => speech(t.say, sess.lang));
    const log = await runSession(sess.lang, pcm);
    out.sessions.push(log);
    if (log.error) out.failures.push(`session error: ${log.error}`);
    if (!log.completed_all) out.failures.push('session ended before every line was spoken');
    sess.turns.forEach((t, i) => {
      const reply = (log.replies[i] || '').toLowerCase();
      for (const group of t.reply_any || []) {
        if (!group.some((w) => reply.includes(w.toLowerCase()))) out.failures.push(`reply ${i + 1} lacks one of [${group.join(', ')}]: "${log.replies[i]}"`);
      }
      for (const w of t.reply_none || []) {
        if (reply.includes(w.toLowerCase())) out.failures.push(`reply ${i + 1} says "${w}": "${log.replies[i]}"`);
      }
      if (t.reply_ask && !reply.includes('?')) out.failures.push(`reply ${i + 1} does not ask: "${log.replies[i]}"`);
    });
    await sleep(SETTLE_MS); // background extraction runs after the turn
  }

  const facts = (await gardenFacts()).filter((f) => !baselineIds.has(f.id) && !SYSTEM_KEY.test(f.fact_key));
  out.facts_after = facts.map((f) => `${f.fact_key}=${f.content}`);
  for (const e of sc.expect_facts || []) {
    const hits = facts.filter((f) => keyLike(e.key, f.fact_key) && (e.value == null || valuesMatch(f.content, e.value)));
    if (e.count != null ? hits.length !== e.count : hits.length === 0) {
      out.failures.push(`expected ${e.count ?? '≥1'} fact ${e.key}${e.value ? `=${e.value}` : ''}, found ${hits.length} (${out.facts_after.join('; ')})`);
    }
  }
  for (const a of sc.absent_facts || []) {
    const hits = facts.filter((f) => keyLike(a.key, f.fact_key) && (a.value == null || valuesMatch(f.content, a.value)));
    if (hits.length) out.failures.push(`must not store ${a.key}${a.value ? `=${a.value}` : ''}: ${hits.map((f) => `${f.fact_key}=${f.content}`).join('; ')}`);
  }
  out.pass = out.failures.length === 0;
  const seeded = new Set((sc.seed_facts || []).map((x) => String(x.value)));
  const judged = [...(sc.expect_facts || []), ...(sc.absent_facts || [])].map((x) => x.value).filter((v) => v != null && !seeded.has(String(v)));
  const hit = judged.find((v) => priorDeleted.some((d) => valuesMatch(d, v)));
  if (hit) out.confounded = `"${hit}" was deleted earlier in this invocation (forgotten marker) — purge markers and re-run alone`;
  return out;
}

// ---------------------------------------------------------------- main
const env = await guard();
const all = JSON.parse(readFileSync(join(HERE, 'scenarios.live.json'), 'utf8')).scenarios;
const scenarios = ONLY ? all.filter((s) => ONLY.includes(s.id)) : all;
mkdirSync(OUT, { recursive: true });
const runStarted = new Date().toISOString();
const baseline = await gardenFacts();
const baselineIds = new Set(baseline.map((f) => f.id));
baselineKeys = new Set(baseline.map((f) => f.fact_key));
console.log(`staging ${env.commit} · ${scenarios.length} scenarios × ${RUNS} runs · baseline ${baseline.length} facts kept untouched`);

const results = [];
for (const sc of scenarios) {
  const runs = [];
  for (let r = 1; r <= RUNS; r++) {
    let res;
    try { res = await runScenario(sc, baselineIds, r); } catch (err) { res = { id: sc.id, run: r, pass: false, failures: [`runner error: ${err.message}`], sessions: [] }; }
    runs.push(res);
    console.log(`${sc.id} run ${r}: ${res.confounded ? 'CONFOUNDED' : res.pass ? 'PASS' : 'FAIL'}${res.pass ? '' : ' — ' + res.failures[0]}${res.confounded ? ' — ' + res.confounded : ''}`);
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ env, runStarted, results: [...results, { ...sc, runs }] }, null, 2));
  }
  results.push({ id: sc.id, category: sc.category, title: sc.title, gap: sc.gap ?? null, pass: runs.every((x) => x.pass), confounded: runs.find((x) => x.confounded)?.confounded ?? null, runs });
}
// Leave the account as it was.
await cleanupSuiteFacts(baselineIds);

const lines = [`# Memory verification — layer B (live, staging)`, '', `Staging commit: \`${env.commit}\` · run started ${runStarted} · ${RUNS} runs per scenario`, ''];
const byCat = {};
for (const r of results) (byCat[r.category] ||= []).push(r);
const clean = (r) => !r.confounded;
lines.push('| Category | Passed | Known gaps | Failed | Confounded |', '|---|---|---|---|---|');
for (const [c, rs] of Object.entries(byCat)) {
  lines.push(`| ${c} | ${rs.filter((r) => clean(r) && r.pass).length}/${rs.length} | ${rs.filter((r) => clean(r) && !r.pass && r.gap).length} | ${rs.filter((r) => clean(r) && !r.pass && !r.gap).length} | ${rs.filter((r) => !clean(r)).length} |`);
}
lines.push('', '## Scenarios', '');
for (const r of results) {
  const mark = r.confounded ? 'CONFOUNDED' : r.pass ? (r.gap ? 'PASS (gap closed — remove the marker)' : 'PASS') : r.gap ? 'KNOWN GAP' : 'FAIL';
  lines.push(`### ${r.id} — ${mark}`, r.title, '');
  if (r.confounded) lines.push(`_${r.confounded}_`, '');
  for (const run of r.runs) {
    lines.push(`- run ${run.run}: ${run.pass ? 'pass' : 'fail'} · sessions ${run.sessions.map((s) => s.session_id).join(', ')}`);
    run.sessions.forEach((s, si) => s.replies?.forEach((rep, i) => lines.push(`  - s${si + 1} line ${i + 1} heard "${s.heard[i]}" → "${rep}"`)));
    for (const f of run.failures) lines.push(`  - ✗ ${f}`);
  }
  lines.push('');
}
writeFileSync(join(OUT, 'report.md'), lines.join('\n'));
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ env, runStarted, results }, null, 2));

const purge = `-- VTID-04600 layer B cleanup: the test user's own rows written since ${runStarted}
delete from memory_fact_forgotten where user_id='${TEST_USER}' and forgotten_at >= '${runStarted}';
delete from memory_facts where user_id='${TEST_USER}' and extracted_at >= '${runStarted}' and fact_key !~* '${SYSTEM_KEY.source}';
delete from memory_items where user_id='${TEST_USER}' and created_at >= '${runStarted}';`;
writeFileSync(join(OUT, 'cleanup.sql'), purge + '\n');
const failed = results.filter((r) => !r.confounded && !r.pass && !r.gap).length;
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed, ${results.filter((r) => !r.pass && r.gap).length} known gaps, ${failed} failed.\nReport: ${join(OUT, 'report.md')}\nRun ${join(OUT, 'cleanup.sql')} to remove the run's remaining rows.`);
process.exit(failed ? 1 : 0);
