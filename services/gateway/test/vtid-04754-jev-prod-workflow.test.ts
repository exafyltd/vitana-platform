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
  const step2Start = prod.indexOf('Build task-definition (2/2');
  const step2 = prod.slice(step2Start, prod.indexOf('NEW_ARN=$(aws ecs register-task-definition', step2Start));

  test('pins the full secret ARN in step 2/2 env (the prod deploy role cannot describe secrets)', () => {
    expect(step2).toContain(`JEV_SECRET_ARN: ${JEV_ARN}`);
  });

  test('upserts TYPESAFE_API_KEY as a secret reference, never a plain env value', () => {
    expect(step2).toMatch(/select\(\.name != "TYPESAFE_API_KEY"\) \]\s*\+ \[ \{name:"TYPESAFE_API_KEY", valueFrom:\$J\} \]/);
    expect(prod).not.toMatch(/name:"TYPESAFE_API_KEY", value:/);
  });

  test('upserts JEV_DECISIONS_ENABLED=true', () => {
    expect(step2).toMatch(/select\(\.name != "JEV_DECISIONS_ENABLED"\) \]\s*\+ \[ \{name:"JEV_DECISIONS_ENABLED", value:"true"\} \]/);
  });

  test('runs after the GITHUB_SAFE_MERGE_TOKEN block and before env_overrides (which may still override it)', () => {
    const gh = step2.indexOf('{name:"GITHUB_SAFE_MERGE_TOKEN", valueFrom:$GH}');
    const jev = step2.indexOf('{name:"TYPESAFE_API_KEY", valueFrom:$J}');
    const ovr = step2.indexOf('if [ -n "$ENV_OVERRIDES_INPUT" ]');
    expect(gh).toBeGreaterThan(-1);
    expect(gh).toBeLessThan(jev);
    expect(jev).toBeLessThan(ovr);
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
