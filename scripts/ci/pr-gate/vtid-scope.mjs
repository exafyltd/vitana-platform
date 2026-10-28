#!/usr/bin/env node
// VTID-04948 — create docs/validation/<VTID>/scope.json from the approved plan's scope.
//
//   node scripts/ci/pr-gate/vtid-scope.mjs init VTID-01234 --kind fix --paths "src/components/foo/**,src/hooks/useFoo.ts" [--sparring-record docs/validation/VTID-01200/plan-sparring.md]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { validateScope } from './lib.mjs';

const [cmd, vtid, ...rest] = process.argv.slice(2);
const opt = (n) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd !== 'init' || !/^VTID-\d{4,5}$/.test(vtid || '')) {
  console.error('usage: vtid-scope.mjs init <VTID> --kind <fix|feature|refactor|infra|docs> --paths "<glob>,<glob>" [--sparring-record <path>]');
  process.exit(2);
}
const scope = {
  vtid,
  kind: opt('kind'),
  paths: String(opt('paths') || '').split(',').map((s) => s.trim()).filter(Boolean),
  ...(opt('sparring-record') ? { sparring_record: opt('sparring-record') } : {}),
  weakens_tests: [],
  red_green_exempt: [],
};
const errors = validateScope(scope, vtid);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const dir = `docs/validation/${vtid}`;
const p = `${dir}/scope.json`;
if (existsSync(p) && !rest.includes('--force')) {
  console.error(`${p} exists (use --force to overwrite)`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileSync(p, `${JSON.stringify(scope, null, 2)}\n`);
console.log(`wrote ${p}`);
