/**
 * VTID-04754: production declares Jev itself instead of relying on the live
 * task definition (rev 140, added by hand 2026-09-30) being carried forward,
 * and the staging probe tells "not found" apart from "access denied".
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');

const JEV_ARN = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/staging/typesafe-api-key-YElucz';

describe('VTID-04754 production Jev declaration', () => {
  // VTID-04824: the Jev block has its own step (step 2/2 had reached GitHub's
  // 20,000-char run limit). It edits the partial task definition step 1/2
  // wrote, before step 2/2 registers it.
  const jevStart = prod.indexOf('- name: Build task-definition (Jev gates)');
  const step2Start = prod.indexOf('- name: Build task-definition (2/2');
  const jevStep = prod.slice(jevStart, step2Start);
  const step2 = prod.slice(step2Start, prod.indexOf('NEW_ARN=$(aws ecs register-task-definition', step2Start));

  test('pins the full secret ARN in the Jev step env (the prod deploy role cannot describe secrets)', () => {
    expect(jevStart).toBeGreaterThan(-1);
    expect(jevStep).toContain(`JEV_SECRET_ARN: ${JEV_ARN}`);
  });

  test('upserts TYPESAFE_API_KEY as a secret reference, never a plain env value', () => {
    expect(jevStep).toMatch(/select\(\.name != "TYPESAFE_API_KEY"\) \]\s*\+ \[ \{name:"TYPESAFE_API_KEY", valueFrom:\$J\} \]/);
    expect(prod).not.toMatch(/name:"TYPESAFE_API_KEY", value:/);
  });

  // VTID-04759 widened the same upsert to also carry the self-healing gate modes.
  test('upserts JEV_DECISIONS_ENABLED=true (strip, then add)', () => {
    expect(jevStep).toMatch(/select\(\.name != "JEV_DECISIONS_ENABLED"[^\]]*\) \]\s*\+ \[ \{name:"JEV_DECISIONS_ENABLED", value:"true"\}/);
  });

  test('reads and writes back the partial task definition, after step 1/2 and before step 2/2 (whose env_overrides may still override it)', () => {
    expect(prod.indexOf('echo "$NEW_DEF" > /tmp/vitana-new-task-def.json')).toBeLessThan(jevStart);
    expect(jevStep).toContain('NEW_DEF="$(cat /tmp/vitana-new-task-def.json)"');
    expect(jevStep).toContain('echo "$NEW_DEF" > /tmp/vitana-new-task-def.json');
    expect(jevStep.indexOf('{name:"TYPESAFE_API_KEY", valueFrom:$J}')).toBeLessThan(jevStep.lastIndexOf('> /tmp/vitana-new-task-def.json'));
    expect(jevStep).not.toMatch(/\n        if:/);
    expect(step2).toContain('NEW_DEF="$(cat /tmp/vitana-new-task-def.json)"');
    expect(step2).toContain('if [ -n "$ENV_OVERRIDES_INPUT" ]');
    expect(step2).not.toContain('TYPESAFE_API_KEY');
    expect(step2).toContain('{name:"GITHUB_SAFE_MERGE_TOKEN", valueFrom:$GH}');
  });

  test('never opens the member plane', () => {
    expect(prod).not.toMatch(/JEV_COMMUNITY_ENABLED"/);
  });
});

describe('VTID-04754 staging probe classifies the AWS error', () => {
  const i = stage.indexOf('- name: Resolve Jev decision config');
  const s = stage.slice(i, stage.indexOf('\n      - name:', i + 1));
  test('keeps stderr instead of discarding it', () => {
    expect(s).not.toMatch(/describe-secret[^\n]*2>\/dev\/null/);
    expect(s).toMatch(/describe-secret[^\n]*2>"\$ERR"/);
  });
  test('names not-found, access-denied and other failures separately', () => {
    expect(s).toContain('ResourceNotFoundException');
    expect(s).toMatch(/AccessDenied/);
    expect(s).toContain('access denied for the deploy role');
    expect(s).toContain('lookup failed');
  });
});
