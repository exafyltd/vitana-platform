/**
 * eng-platform-p01 / aws-inventory — scripts/aws/inventory-readonly.sh must stay read-only.
 *
 * Reads the script text (it does not run it, no AWS access in CI) and asserts:
 *   1. strict mode and the account guard (CLAUDE.md IF-THEN 11) are present;
 *   2. every AWS call made through the script's `run` helper uses a describe-*, list-* or get-* verb;
 *   3. no secret value, decrypted parameter, upload or mutating verb appears outside comments.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/inventory-readonly.sh');

let text = '';
let code: string[] = [];

beforeAll(() => {
  text = fs.readFileSync(SCRIPT, 'utf8');
  // Lines that are code, not comments; line continuations joined so a call is one line.
  code = text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));
});

describe('inventory-readonly.sh', () => {
  it('runs in strict mode', () => {
    expect(text).toMatch(/^set -euo pipefail$/m);
  });

  it('refuses to run against any account but 472838866351', () => {
    expect(text).toContain('EXPECTED_ACCOUNT="472838866351"');
    expect(text).toMatch(/aws sts get-caller-identity/);
    expect(text).toMatch(/if \[ "\$ACCOUNT" != "\$EXPECTED_ACCOUNT" \]; then[\s\S]*?exit 4/);
  });

  it('only calls describe-*, list-* and get-* APIs through run()', () => {
    const calls = code.filter((l) => /^\s*run\s+\S+\s+\S+\s+\S+\s+\S+/.test(l));
    expect(calls.length).toBeGreaterThan(30);
    for (const l of calls) {
      const verb = l.trim().split(/\s+/)[4];
      expect({ line: l.trim(), ok: /^(describe|list|get)-/.test(verb) }).toEqual({ line: l.trim(), ok: true });
    }
  });

  it('calls aws directly only for get-caller-identity and inside run()', () => {
    const direct = code.filter((l) => /(^|[\s$(])aws\s/.test(l) && !/command -v aws/.test(l));
    for (const l of direct) {
      expect(/aws sts get-caller-identity|aws --region "\$REGION" --output json "\$@"/.test(l)).toBe(true);
    }
  });

  it('never reads secret values, decrypts parameters, uploads or mutates', () => {
    const body = code.join('\n');
    for (const bad of ['get-secret-value', '--with-decryption', 's3 cp', 's3 sync', 's3api put-']) {
      expect(body).not.toContain(bad);
    }
    expect(body).not.toMatch(/\s(put|create|delete|update|modify|tag|attach|detach|start|stop|run)-[a-z]/);
  });
});
