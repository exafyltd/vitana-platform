// VTID-05803 (staging cutover to vitana-aurora-staging): once the VTID-05781 switch (scripts/aws/staging-cutover-taskdef.mjs
// --plane isolated, applied by scripts/aws/staging-cutover-ecs.sh flip) has put the live staging gateway and PostgREST
// proxy on the staging database, every later GitLab `deploy-staging:gateway` / `deploy-staging:postgrest-aurora-proxy`
// render (deploy-ecs.mjs renderTaskDefinition, from the live definition) must keep the isolated plane: same data-plane
// secrets, the STAGING_DATA_PLANE marker and its backup, VTID_ALLOCATOR_ENABLED=false, and no production Aurora
// reference. No AWS, no network.
//   node --test scripts/eng/deploy/deploy-ecs.staging-plane.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTaskDefinition, diffTaskDefinitions } from './deploy-ecs.mjs';
import { target, REGISTRY } from './lib.mjs';
import { transformText, MARKER, BACKUP, isolatedAuroraLeaks } from '../../aws/staging-cutover-taskdef.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.resolve(HERE, '..', '..', 'ci', 'staging-db', 'fixtures', 'cutover');
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';
const ARNS = {
  database_url: `${SM}vitana/aurora/staging-db/database-url-AbCdEf`,
  authenticator_uri: `${SM}vitana/aurora/staging-db/postgrest-authenticator-uri-GhIjKl`,
};
const SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const GW_OVERRIDES = { PM_AGENT_ENABLED: 'false', DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' };

const isolated = (file, service) => JSON.parse(transformText(fs.readFileSync(path.join(FX, file), 'utf8'),
  { plane: 'isolated', service, arns: ARNS }));
const entries = (td) => td.containerDefinitions.flatMap((c) => ['environment', 'secrets']
  .flatMap((k) => (c[k] || []).map((e) => [`${c.name} ${k} ${e.name}`, e.value ?? e.valueFrom])));
const COMMIT_VARS = /env (GIT_COMMIT_SHA|COMMIT_SHA|BUILD_INFO_MARKER)$/;

for (const [service, file, plane, overrides] of [
  ['gateway', 'taskdef-gateway.json', 'gateway', GW_OVERRIDES],
  ['postgrest-aurora-proxy', 'taskdef-postgrest.json', 'postgrest', null],
]) {
  test(`${service}: a GitLab deploy of the isolated live definition keeps the whole isolated data plane`, () => {
    const live = isolated(file, plane);
    const t = target(service);
    const image = `${REGISTRY}/${t.ecrRepository}@${DIGEST}`;
    const rendered = renderTaskDefinition(live, t, { image, sha: SHA, envOverrides: overrides });

    // Every secret and every environment entry is the same, except the commit variables and the job's env overrides.
    const before = new Map(entries(live));
    const after = new Map(entries(rendered));
    const allowed = new Set(Object.keys(overrides || {}).map((k) => `${live.containerDefinitions.find((c) => c.image && c.image.includes(t.ecrRepository)).name} environment ${k}`));
    for (const [k, v] of before) {
      if (COMMIT_VARS.test(k.replace(' environment ', ' env ')) || allowed.has(k)) continue;
      assert.equal(after.get(k), v, `${k} changed`);
    }
    for (const k of after.keys()) {
      if (!before.has(k)) assert.ok(allowed.has(k) || COMMIT_VARS.test(k.replace(' environment ', ' env ')), `${k} added`);
    }
    // The plane marker and its backup survive, so a later shared restore still has what it needs.
    const env = rendered.containerDefinitions.flatMap((c) => c.environment || []);
    assert.equal(env.find((e) => e.name === MARKER)?.value, 'isolated');
    assert.ok(env.some((e) => e.name === BACKUP));
    // No production Aurora reference reappears.
    assert.deepEqual(isolatedAuroraLeaks(rendered), []);
    // Only the image of the service's own container and the commit/override env lines differ.
    for (const line of diffTaskDefinitions(live, rendered)) {
      assert.match(line, /image: |env (GIT_COMMIT_SHA|COMMIT_SHA|BUILD_INFO_MARKER|PM_AGENT_ENABLED|DELIVERY_HOST_VITANA_PLATFORM|DELIVERY_HOST_VITANA_V1):/, line);
    }
  });
}

test('gateway: the isolated live definition stays isolated across two consecutive GitLab deploys', () => {
  const t = target('gateway');
  const live = isolated('taskdef-gateway.json', 'gateway');
  const once = renderTaskDefinition(live, t, { image: `${REGISTRY}/${t.ecrRepository}@${DIGEST}`, sha: SHA, envOverrides: GW_OVERRIDES });
  const twice = renderTaskDefinition(once, t, { image: `${REGISTRY}/${t.ecrRepository}@sha256:${'e'.repeat(64)}`, sha: 'c'.repeat(40), envOverrides: GW_OVERRIDES });
  const pick = (td) => entries(td).filter(([k]) => / secrets /.test(k) || k.endsWith(` ${MARKER}`) || k.endsWith(` ${BACKUP}`) || k.endsWith(' VTID_ALLOCATOR_ENABLED'));
  assert.deepEqual(pick(twice), pick(live));
  const alloc = twice.containerDefinitions[0].environment.find((e) => e.name === 'VTID_ALLOCATOR_ENABLED');
  assert.equal(alloc?.value, 'false');
});
