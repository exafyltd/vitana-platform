/**
 * VTID-04443 (Plan v1 WS-4.4) — record a conversation replay case from a real
 * session, with the member's consent.
 *
 *   npx tsx scripts/record-replay-case.ts \
 *     --summary <file with the JSON `data` of GET /api/v1/admin/conversation/sessions/:id/brain> \
 *     --id <case-id> --consent <consent reference>
 *
 * Reads a brain-inspector summary that an admin saved to a file (this script
 * makes no network call and reads no database), keeps only what the brain
 * decided from — language, route, opener, provider statuses — and writes a
 * case skeleton to test/fixtures/conversation-replay/cases/<id>.json. No user
 * id, session id or spoken text is kept. The author then adds synthetic turns
 * and expectations, runs `npm run test:replay -- -u`, and reviews the new
 * snapshot. Refuses without --consent.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { caseSkeletonFromInspector } from '../src/services/conversation/replay/conversation-replay';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const summaryPath = arg('summary');
  const id = arg('id');
  const consent = arg('consent');
  if (!summaryPath || !id || !consent) {
    console.error('usage: record-replay-case --summary <file> --id <case-id> --consent <consent reference>');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const summary = raw && typeof raw === 'object' && raw.data ? raw.data : raw;
  const c = caseSkeletonFromInspector(summary, { id, consentRef: consent, recordedAt: new Date().toISOString().slice(0, 10) });
  const out = join(__dirname, '../test/fixtures/conversation-replay/cases', `${id}.json`);
  if (existsSync(out)) {
    console.error(`${out} already exists; choose another id`);
    process.exit(1);
  }
  writeFileSync(out, `${JSON.stringify(c, null, 1)}\n`);
  console.log(`wrote ${out} — add synthetic turns and expectations, then: npm run test:replay -- -u`);
}

if (require.main === module) main();
