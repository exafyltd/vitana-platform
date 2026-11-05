// The verdict of land-guard.mjs `mergeDecision` next to the verdict of the merge bot's `decide` for every combination of the
// gates, as a table. The bot lands exactly when mergeDecision says ok, waits exactly when it says pending, and updates exactly
// when being behind main is the only thing missing.
// usage: node verdict-table.mjs <repository root>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? '.');
const { decide } = await import(pathToFileURL(path.join(ROOT, 'scripts/eng/gitlab-land.mjs')).href);
const { mergeDecision } = await import(pathToFileURL(path.join(ROOT, 'scripts/collab/land-guard.mjs')).href);

const reviews = [['review ok', { ok: true, reason: 'current' }], ['no review', { ok: false, reason: 'no accept', code: 'no_review' }]];
const checkSets = [['checks pass', { state: 'pass', detail: 'green' }], ['checks fail', { state: 'fail', detail: 'unit=failure' }], ['checks pending', { state: 'pending', detail: 'unit=queued' }]];
const rows = [];
let differences = 0;
for (const [rl, review] of reviews) for (const [cl, checks] of checkSets) for (const behindBy of [0, 3]) for (const protectedFiles of [[], ['CLAUDE.md']]) {
  const m = mergeDecision({ review, checks, behindBy, protectedFiles });
  const d = decide({ review, checks, behindBy, protectedFiles });
  const mergeWord = m.ok ? 'ok' : m.code === 2 ? 'pending' : 'refused';
  const consistent = (m.ok && d.action === 'land') || (m.code === 2 && d.action === 'wait') || (m.code === 1 && (d.action === 'skip' || d.action === 'update'));
  if (!consistent || d.reason !== m.reason) differences += 1;
  rows.push(`| ${rl} | ${cl} | ${behindBy} | ${protectedFiles.length ? 'CLAUDE.md' : '-'} | ${mergeWord} (${m.code}) | ${d.action} | ${d.reasonCode} | ${consistent && d.reason === m.reason ? 'same' : 'DIFFERENT'} |`);
}
console.log('| review | checks | behind by | protected | mergeDecision | bot action | reason code | same verdict and reason |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
console.log(`\n${rows.length} combinations, ${differences} differences.`);
process.exit(differences === 0 ? 0 : 1);
