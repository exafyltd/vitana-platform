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

describe('route-mount evidence keys off an ADDED route, not a touched file', () => {
  const req = (lines: string[]): boolean => guard.routeEvidenceRequired(lines);

  it('requires evidence when a route is actually added', () => {
    expect(req(["+router.get('/api/v1/thing', handler);"])).toBe(true);
    expect(req(['+  app.use(\'/api/v1/orb\', orbRouter);'])).toBe(true);
    expect(req(["+router.post('/x', h)"])).toBe(true);
  });

  it('does NOT require evidence for a route file edited without adding a route', () => {
    // The VTID-03692 shape: a branch added inside an existing WS handler.
    expect(
      req([
        "+  if (__upstreamDecision.provider === 'cascaded') {",
        '+    const cascadedClient = createUpstreamClient(...);',
        '+    resolve(cascadedFacade);',
        '+  }',
      ]),
    ).toBe(false);
  });

  it('ignores removed and context lines', () => {
    // A deleted route must not demand fresh curl proof for a URL that is gone.
    expect(req(["-router.get('/api/v1/gone', handler);"])).toBe(false);
    expect(req(["   router.get('/api/v1/existing', handler);"])).toBe(false);
  });

  it('ignores the +++ file header, which is not an added line', () => {
    expect(req(['+++ b/services/gateway/src/routes/router.get.ts'])).toBe(false);
  });

  it('requires evidence if any added line registers a route, among many that do not', () => {
    expect(
      req(['+const x = 1;', '+// comment', "+router.delete('/api/v1/thing/:id', h);"]),
    ).toBe(true);
  });

  it('treats an empty diff as not requiring evidence', () => {
    expect(req([])).toBe(false);
    expect(req([''])).toBe(false);
  });
});

describe('CSP scanning is scoped to the browser-served surface', () => {
  const targets = (files: string[]): string[] => guard.cspScanTargets(files);

  it('scans the command-hub frontend trees', () => {
    expect(
      targets([
        'services/gateway/src/frontend/command-hub/app.js',
        'services/gateway/dist/frontend/command-hub/index.html',
      ]),
    ).toHaveLength(2);
  });

  it('does not scan the validator workflow — which contains the CSP patterns itself', () => {
    // The trap: VALIDATOR-CHECK.yml holds the pattern list as its own source,
    // so scanning it flagged `<script`, `.style` and `unsafe-inline` every time.
    // That made the validator reject any PR that edits the validator.
    expect(targets(['.github/workflows/VALIDATOR-CHECK.yml'])).toEqual([]);
  });

  it('does not scan lockfiles — a registry URL is not a CDN asset', () => {
    expect(targets(['services/gateway/package-lock.json'])).toEqual([]);
  });

  it('does not scan markdown, CI scripts or migrations', () => {
    expect(
      targets([
        'CLAUDE.md',
        'scripts/ci/validator-path-guard.cjs',
        'supabase/migrations/data-fixups/x.sql',
      ]),
    ).toEqual([]);
  });

  it('does not scan gateway backend source — it is not served to a browser', () => {
    expect(targets(['services/gateway/src/routes/orb-live.ts'])).toEqual([]);
  });

  it('picks the frontend files out of a mixed change set', () => {
    expect(
      targets([
        'CLAUDE.md',
        'services/gateway/src/frontend/command-hub/styles.css',
        'services/gateway/src/routes/orb-live.ts',
      ]),
    ).toEqual(['services/gateway/src/frontend/command-hub/styles.css']);
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

// ---------------------------------------------------------------------------
// VTID-03706 — the CSP gate judged WHOLE FILES, which made it structurally
// unpassable for any PR touching orb-widget.js or index.html.
//
// Measured on origin/main, before any change: orb-widget.js hits `.style`,
// `style=`, the inline-<script> pattern and the remote-asset pattern;
// index.html hits the inline-<script> pattern. So the gate never said "this PR
// introduces a violation" — it said "this file has ever contained one", and
// the only way to pass was to not touch the file.
//
// Same defect family this workflow was already fixed for twice (VTID-03696:
// the gate flagging its own PATTERNS list; the lockfile deny making any
// dependency-adding PR unsatisfiable). Remedy is VTID-03696's own — judge
// ADDED lines.
// ---------------------------------------------------------------------------

const CSP_PATTERNS = guard.CSP_PATTERNS as RegExp[];

function cspScan(diff: string) {
  return guard.cspAddedLineViolations(diff.split('\n'), CSP_PATTERNS) as Array<{
    file: string;
    line: string;
  }>;
}

/** A minimal unified diff for one file. */
function diffFor(file: string, lines: string[]) {
  return ['--- a/' + file, '+++ b/' + file, '@@ -1,1 +1,1 @@', ...lines].join('\n');
}

describe('VTID-03706 CSP gate judges added lines only', () => {
  const WIDGET = 'services/gateway/src/frontend/command-hub/orb-widget.js';

  it('flags a NEWLY ADDED inline style assignment', () => {
    const v = cspScan(diffFor(WIDGET, ['+  el.style.background = "red";']));
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe(WIDGET);
  });

  it('does NOT flag a pre-existing violation carried as a context line', () => {
    // THE regression this fixes. A context line is the file as it already is;
    // blaming this PR for it blocks unrelated work and fixes nothing.
    expect(cspScan(diffFor(WIDGET, ['   el.style.background = "red";']))).toHaveLength(0);
  });

  it('does NOT flag a violation being REMOVED', () => {
    expect(cspScan(diffFor(WIDGET, ['-  el.style.background = "red";']))).toHaveLength(0);
  });

  it('does NOT flag the +++ file header', () => {
    // `+++ b/…` starts with '+', so a naive startsWith('+') scans the PATH and
    // re-flags a file merely for appearing in the diff.
    const styleFile = 'services/gateway/src/frontend/command-hub/x.style.js';
    expect(
      cspScan(['--- a/' + styleFile, '+++ b/' + styleFile, '@@ -1 +1 @@', ' ok'].join('\n')),
    ).toHaveLength(0);
  });

  it('ignores added lines outside the browser-served surface', () => {
    // A backend .ts file is not served to a browser; the patterns mean nothing
    // there and flagging them is the false-positive class VTID-03696 removed.
    const v = cspScan(diffFor('services/gateway/src/routes/orb-live.ts', ['+  el.style.x = 1;']));
    expect(v).toHaveLength(0);
  });

  it('still catches every pattern class on an added line', () => {
    const cases = [
      '+  <scr' + 'ipt>alert(1)</scr' + 'ipt>',
      '+  <div st' + 'yle="color:red">',
      '+  node.st' + 'yle.color = "red";',
      '+  ev' + 'al("x");',
      '+  new Fun' + 'ction("x");',
      '+  content="un' + 'safe-inline"',
      '+  <link href="https://cdn.example.com/a.css">',
    ];
    for (const c of cases) {
      expect(cspScan(diffFor(WIDGET, [c])).length).toBeGreaterThan(0);
    }
  });

  it('does not flag an external <script src=…>, which is the sanctioned form', () => {
    expect(
      cspScan(diffFor(WIDGET, ['+  <scr' + 'ipt src="/command-hub/app.js"></scr' + 'ipt>'])),
    ).toHaveLength(0);
  });

  it('handles a deleted file (+++ /dev/null) without attributing lines to it', () => {
    expect(
      cspScan(['--- a/' + WIDGET, '+++ /dev/null', '@@ -1 +0,0 @@', '-  el.style.x = 1;'].join('\n')),
    ).toHaveLength(0);
  });
});

describe('VTID-03706 the CSP patterns cannot flag their own source', () => {
  it('no pattern matches the CSP_PATTERNS declaration block', () => {
    // VTID-03696 recorded VALIDATOR-CHECK.yml flagging itself, "because the
    // PATTERNS list below IS those strings" — so the validator could not be
    // edited without the validator failing the change. Moving the list into
    // this module would have relocated that trap rather than removed it, so
    // the patterns are assembled from fragments. This is what keeps that true
    // if someone later "tidies" them back into literals.
    //
    // Scoped to the DECLARATION BLOCK, not the whole file: the surrounding
    // VTID-03696 prose legitimately quotes the flagged literals while
    // explaining this exact history, and `scripts/` is outside CSP_SURFACE so
    // the real gate never reads any of it. The invariant that matters is that
    // the pattern list itself stays literal-free.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const src = readFileSync(
      require.resolve('../../../../scripts/ci/validator-path-guard.cjs'),
      'utf8',
    ) as string;
    const start = src.indexOf('const CSP_PATTERNS = [');
    const block = src.slice(start, src.indexOf('];', start) + 2);
    expect(start).toBeGreaterThan(-1);
    for (const p of CSP_PATTERNS) {
      expect({ pattern: String(p), matched: p.test(block) }).toEqual({
        pattern: String(p),
        matched: false,
      });
    }
  });
});
