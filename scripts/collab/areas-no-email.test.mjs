// VTID-05699 (plan privacy-ledger-auth, lane areas-emails): the seat file names seats, never the accounts behind them.
// Owner instruction 2026-11-11: no email addresses in the repository's seat file. The failure message gives the line
// number only, never the matched text, so a failing run does not copy an address into a CI log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AREAS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'programs', 'areas.yaml');
const ADDRESS = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/** 1-based numbers of the lines that contain something shaped like an email address. */
export function addressLines(text) {
  return text.split('\n').flatMap((line, i) => (ADDRESS.test(line) ? [i + 1] : []));
}

test('addressLines finds an address and reports only its line number', () => {
  const sample = ['someone', 'example.org'].join('@'); // built at run time: no address literal in the repository
  assert.deepEqual(addressLines(`seats:\n  a: { account: ${sample} }\n  b: { surface: kiro-web }\n`), [2]);
  assert.deepEqual(addressLines('seats:\n  b: { surface: kiro-web, automation: .kiro/automations/b.md }\n'), []);
});

test('docs/programs/areas.yaml contains no email address', () => {
  const lines = addressLines(readFileSync(AREAS, 'utf8'));
  assert.deepEqual(lines, [], `docs/programs/areas.yaml has an email address on line(s) ${lines.join(', ')}; keep seat names only`);
});
