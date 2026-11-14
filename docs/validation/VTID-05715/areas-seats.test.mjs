// VTID-05715 (plan kiro-fleet-register, lane seats): the seat map names every Kiro account slot that has a seat.
// Kiro 1-3 and 12 run sessions today; Kiro 4-8 are named accounts whose seats exist ahead of their first session
// (surface: pending); slots 9-11 are reserved and have no seat. A seat is the configured identity, not a login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeats } from '../../../scripts/collab/queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lines = () => fs.readFileSync(path.join(ROOT, 'docs/programs/areas.yaml'), 'utf8').split('\n');
function seatLines() {
  const out = {}; let inSeats = false;
  for (const l of lines()) {
    if (/^\S/.test(l)) { inSeats = /^seats:\s*(#.*)?$/.test(l); continue; }
    const m = inSeats && /^ {2}([a-z]{1,12}):\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

test('loadSeats returns the nine seats, none renamed or removed', () => {
  assert.deepEqual([...Object.keys(seatLines())].sort(), ['admin', 'exafy', 'exafyltd', 'hotmail', 'jtadic', 'office', 'support', 'tasks', 'vitanaland']);
});
test('loadSeats at HEAD agrees with the line parse', () => { assert.deepEqual([...loadSeats(ROOT, 'HEAD')].sort(), Object.keys(seatLines()).sort()); });

test('every seat line is one-line { … }, carries kiro: <slot>, and no account', () => {
  const s = seatLines();
  const slots = {};
  for (const [k, v] of Object.entries(s)) {
    assert.match(v, /^\{[^{}]*\}\s*(#.*)?$/, `${k}: not a one-line { … } entry`);
    assert.doesNotMatch(v, /\baccount\s*:/, `${k}: has an account field`);
    const m = /\bkiro:\s*(\d+)\b/.exec(v);
    assert.ok(m, `${k}: no kiro slot`);
    slots[k] = Number(m[1]);
  }
  assert.deepEqual(slots, { jtadic: 12, exafyltd: 3, hotmail: 1, exafy: 2, vitanaland: 4, office: 5, support: 6, admin: 7, tasks: 8 });
});

test('the five new seats are pending and have no automation', () => {
  const s = seatLines();
  for (const k of ['vitanaland', 'office', 'support', 'admin', 'tasks']) {
    assert.match(s[k], /\bsurface:\s*pending\b/, `${k}: surface is not pending`);
    assert.doesNotMatch(s[k], /\bautomation\s*:/, `${k}: has an automation`);
  }
});
