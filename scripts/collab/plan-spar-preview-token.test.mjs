// preview-gateway-recovery / plan-spar-token: PLAN-SPAR sends the dedicated preview token when the repo secret
// PLAN_SPAR_GATEWAY_TOKEN exists, and forces VTID allocation off while it does. Without that secret the two env
// values evaluate exactly as before (GATEWAY_SERVICE_TOKEN, vars.PLAN_SPAR_ALLOCATE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const y = readFileSync(path.join(ROOT, '.github/workflows/PLAN-SPAR.yml'), 'utf8');
const sparAt = y.indexOf('      - name: Spar\n');
assert.ok(sparAt > 0, 'PLAN-SPAR.yml has a Spar step');
const spar = y.slice(sparAt, y.indexOf('      - name: ', sparAt + 10));
const envLine = (name) => (spar.match(new RegExp(`^\\s+${name}: (.*)$`, 'm')) || [])[1];

// A minimal evaluator for the GitHub Actions expression grammar these two lines use: `secrets.X` / `vars.X`
// (unset = ''), string literals, `==`, `&&`, `||` with Actions semantics (&& / || return an operand; '' is falsy).
// The truth tables below evaluate the expression text parsed from the workflow, not a copy of it.
function evaluate(expr, ctx) {
  const body = expr.match(/^\$\{\{\s*(.*?)\s*\}\}$/)[1];
  const val = (t) => {
    t = t.trim();
    const lit = t.match(/^'(.*)'$/);
    if (lit) return lit[1];
    const ref = t.match(/^(secrets|vars)\.([A-Z_]+)$/);
    assert.ok(ref, `unsupported operand ${t}`);
    return ctx[ref[1]][ref[2]] ?? '';
  };
  const cmp = (t) => { const m = t.split(/\s*==\s*/); return m.length === 2 ? val(m[0]) === val(m[1]) : val(t); };
  const and = (t) => t.split(/\s*&&\s*/).map(cmp).reduce((a, b) => (a ? b : a));
  return body.split(/\s*\|\|\s*/).map(and).reduce((a, b) => (a ? a : b));
}
const ctx = (preview, allocate) => ({
  secrets: { PLAN_SPAR_GATEWAY_TOKEN: preview, GATEWAY_SERVICE_TOKEN: 'shared' },
  vars: { PLAN_SPAR_ALLOCATE: allocate },
});

test('the Spar step sends the preview token when it exists, else the shared token', () => {
  assert.equal(envLine('GATEWAY_SERVICE_TOKEN'), '${{ secrets.PLAN_SPAR_GATEWAY_TOKEN || secrets.GATEWAY_SERVICE_TOKEN }}');
  const e = envLine('GATEWAY_SERVICE_TOKEN');
  assert.equal(evaluate(e, ctx('preview', '')), 'preview');
  assert.equal(evaluate(e, ctx('', '')), 'shared');
});

test('allocation is forced off while the preview token is set; unchanged otherwise', () => {
  assert.equal(envLine('PLAN_SPAR_ALLOCATE'), "${{ secrets.PLAN_SPAR_GATEWAY_TOKEN == '' && vars.PLAN_SPAR_ALLOCATE || 'false' }}");
  const e = envLine('PLAN_SPAR_ALLOCATE');
  // preview token set: never allocates, whatever the variable says
  assert.equal(evaluate(e, ctx('preview', 'true')), 'false');
  assert.equal(evaluate(e, ctx('preview', '')), 'false');
  // no preview token: today's behaviour (plan-spar.mjs allocates only on the exact string 'true')
  assert.equal(evaluate(e, ctx('', 'true')), 'true');
  assert.notEqual(evaluate(e, ctx('', '')), 'true');
  assert.notEqual(evaluate(e, ctx('', 'false')), 'true');
});

test('the gateway URL, the trigger and the job condition are unchanged', () => {
  assert.equal(envLine('GATEWAY_URL'), "${{ vars.PLAN_SPAR_GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com' }}");
  assert.match(y, /pull_request_target:/);
  assert.doesNotMatch(y, /^\s+if:.*secrets\./m, 'no if: reads the secrets context');
});
