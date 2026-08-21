// VTID-03696 — unit tests for VALIDATOR-CHECK's path-ownership guard.
//
// This guard had no tests and was silently broken twice — once by a YAML block
// scalar that made the whole workflow unparseable (VTID-03505), once by invalid
// awk that failed every PR regardless of content (VTID-03549). Both failures
// were invisible in review and neither could have survived a test run.
//
// So these pin BEHAVIOUR, not spelling: what the gate approves, what it
// rejects, and — the VTID-03696 fix — what it deliberately does not judge.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../../scripts/ci/validator-path-guard.cjs');

type Result = { code: number; messages: string[] };

function run(
  profile: string,
  changedFiles: string[],
  dependencyChangeDeclared = false,
): Result {
  return guard.evaluate({ profile, changedFiles, dependencyChangeDeclared });
}

describe('the remit is exactly the workflow trigger', () => {
  it('matches the paths: list in VALIDATOR-CHECK.yml', () => {
    // If these drift, the gate goes back to judging files it was never
    // triggered to look at — which IS the VTID-03696 bug. Read the workflow
    // rather than restating the list, so the test cannot agree with a stale copy.
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const yml = readFileSync(
      join(__dirname, '../../../../.github/workflows/VALIDATOR-CHECK.yml'),
      'utf8',
    );
    const triggerBlock = yml.slice(yml.indexOf('    paths:'), yml.indexOf('jobs:'));
    const triggerPaths: string[] = [...triggerBlock.matchAll(/- '([^']+)'/g)]
      .map((m) => (m[1] as string).replace(/\*\*$/, ''))
      .sort();
    expect(triggerPaths).toEqual([...guard.REMIT].sort());
  });
});

describe('gateway_backend — the ordinary cases', () => {
  it('approves a PR confined to the gateway source tree', () => {
    const r = run('gateway_backend', [
      'services/gateway/src/routes/orb-live.ts',
      'services/gateway/test/orb/live/upstream/cascaded-wiring.test.ts',
    ]);
    expect(r.code).toBe(0);
  });

  it('approves evidence docs alongside source', () => {
    const r = run('gateway_backend', [
      'services/gateway/src/index.ts',
      'docs/validation/VTID-03696/acceptance.md',
    ]);
    expect(r.code).toBe(0);
  });
});

describe('the VTID-03696 fix — out-of-remit files are reported, not rejected', () => {
  // The exact shape that made PR #3144 structurally unpassable: a real gateway
  // change that also touches infra, scripts, docs and a migration.
  const mixed = [
    'services/gateway/src/routes/orb-live.ts',
    'services/gateway/test/orb/live/upstream/cascaded-wiring.test.ts',
    '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml',
    'CLAUDE.md',
    'scripts/aws/setup-narration-audio-cache.sh',
    'scripts/tts/verify-polly-voices.ts',
    'services/gateway/.env.example',
    'supabase/migrations/data-fixups/20260821110000_VTID_03695_seed.sql',
  ];

  it('approves the mixed PR that previously could not pass under any profile', () => {
    expect(run('gateway_backend', mixed).code).toBe(0);
  });

  it('says out loud which files it did not judge', () => {
    const { messages } = run('gateway_backend', mixed);
    const joined = messages.join('\n');
    expect(joined).toContain('NOT JUDGED');
    expect(joined).toContain('scripts/aws/setup-narration-audio-cache.sh');
    expect(joined).toContain('CLAUDE.md');
  });

  it('does not present "not judged" as approval of those trees', () => {
    // The honest-reporting requirement. A silent pass here would read as
    // "the whole PR was validated", which is exactly what it is not.
    const joined = run('gateway_backend', mixed).messages.join('\n');
    expect(joined).toMatch(/no governance gate of their own/i);
  });

  it('.env.example is NOT treated as a committed .env', () => {
    // Easy and very annoying regression: the deny regex must not catch the
    // checked-in template that people are supposed to edit.
    expect(run('gateway_backend', ['services/gateway/.env.example']).code).toBe(0);
  });
});

describe('what the guard still rejects', () => {
  it('rejects a committed .env anywhere, ignoring remit', () => {
    // Deliberately NOT remit-scoped — a leaked secret does not care which
    // directory it landed in.
    const r = run('gateway_backend', ['scripts/thing/.env']);
    expect(r.code).toBe(20);
    expect(r.messages.join('\n')).toContain('.env file committed');
  });

  it('rejects a bare .env at the repo root', () => {
    expect(run('gateway_backend', ['.env']).code).toBe(20);
  });

  it('rejects an unknown profile', () => {
    const r = run('not_a_profile', ['services/gateway/src/index.ts']);
    expect(r.code).toBe(21);
    expect(r.messages.join('\n')).toContain('known profiles');
  });

  it('rejects an in-remit file outside the declared profile — the check that still has teeth', () => {
    // command_hub_frontend means "the command-hub frontend and nothing else in
    // the gateway". A routes change under that profile is a real violation.
    const r = run('command_hub_frontend', [
      'services/gateway/src/frontend/command-hub/app.js',
      'services/gateway/src/routes/orb-live.ts',
    ]);
    expect(r.code).toBe(22);
    expect(r.messages.join('\n')).toContain('services/gateway/src/routes/orb-live.ts');
  });

  it('does not let out-of-remit files mask an in-remit violation', () => {
    const r = run('command_hub_frontend', [
      'scripts/whatever.sh',
      'services/gateway/src/routes/orb-live.ts',
    ]);
    expect(r.code).toBe(22);
  });
});

describe('dependency changes are declared, not forbidden', () => {
  const withLock = [
    'services/gateway/src/services/tts/narration-audio-cache.ts',
    'services/gateway/package.json',
    'services/gateway/package-lock.json',
    'services/gateway/pnpm-lock.yaml',
  ];

  it('rejects an undeclared lockfile change', () => {
    const r = run('gateway_backend', withLock, false);
    expect(r.code).toBe(23);
    expect(r.messages.join('\n')).toContain('DEPENDENCY_CHANGE:');
  });

  it('approves the same change once declared', () => {
    // The old rule rejected any lockfile outright, so the gate could never
    // approve a PR that adds a dependency — a legitimate, routine change.
    const r = run('gateway_backend', withLock, true);
    expect(r.code).toBe(0);
  });

  it('still reports the dependency change when declared', () => {
    const joined = run('gateway_backend', withLock, true).messages.join('\n');
    expect(joined).toContain('dependency change declared');
  });

  it('catches yarn.lock too, not just npm and pnpm', () => {
    expect(run('gateway_backend', ['yarn.lock'], false).code).toBe(23);
  });

  it('ranks a committed .env above an undeclared lockfile', () => {
    // Both present: the secret is the more serious finding and must be the one
    // reported, rather than being hidden behind a dependency complaint.
    const r = run('gateway_backend', ['services/gateway/package-lock.json', '.env'], false);
    expect(r.code).toBe(20);
  });
});

describe('degenerate input', () => {
  it('ignores blank lines and surrounding whitespace', () => {
    const r = run('gateway_backend', ['', '  services/gateway/src/a.ts  ', '']);
    expect(r.code).toBe(0);
  });

  it('approves an empty change set rather than throwing', () => {
    // The workflow already rejects an empty diff earlier (exit 16); this guard
    // must not be the thing that explodes if that check ever moves.
    expect(run('gateway_backend', []).code).toBe(0);
  });
});
