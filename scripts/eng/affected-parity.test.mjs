// VTID-05550 (plan agentic-delivery §3.4): merge-request selection is never narrower than GitHub's path filters.
// The fixtures hold the last 60 merged PRs of each repository: their changed files and the pull-request workflows that
// ran on the PR's final head (read once through read-only `gh api` GETs, commands in docs/validation/VTID-05550).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE = process.env.PIPELINE_GEN_MODULE || path.join(ROOT, 'scripts/eng/pipeline-gen.mjs');
const gen = await import(pathToFileURL(MODULE).href);
const config = gen.loadServices(ROOT);

for (const repo of ['vitana-v1', 'vitana-platform']) {
  const r = config.repositories[repo];
  const fx = JSON.parse(readFileSync(path.join(ROOT, r.fixture), 'utf8'));

  test(`${repo}: the fixture holds the last 60 merged PRs with their files and workflows`, () => {
    assert.equal(fx.schema, 'vitana.delivery-pr-files/v1');
    assert.equal(fx.repository, r.github_repository);
    assert.equal(fx.prs.length, 60);
    for (const pr of fx.prs) {
      assert.ok(pr.files.length > 0, `#${pr.number} has no files`);
      assert.ok(Object.keys(pr.workflows).length > 0, `#${pr.number} has no workflow run`);
    }
  });

  // Lane eng-gitlab-m2 settings' free-tier guard scans the raw text of scripts/eng for Premium API names; a PR's file
  // name such as .kiro/specs/<slug>/lanes/approvals-auth.md would read as GET /projects/:id/approvals. Such a slash is
  // written as the JSON escape \u002f, so the parsed fixture keeps the real path (review round 1).
  test(`${repo}: the fixture's raw text names no Premium approvals path, and parses to the real file names`, () => {
    const raw = readFileSync(path.join(ROOT, r.fixture), 'utf8');
    assert.doesNotMatch(raw, /(?<!merge_requests\/[^\s'"`/]{1,40})\/approvals\b/);
    if (repo === 'vitana-platform') assert.ok(fx.prs.some((pr) => pr.files.includes('.kiro/specs/mt-track-s-authz/lanes/approvals-auth.md')));
  });

  test(`${repo}: every pull-request workflow that ran is in the service list registry`, () => {
    const reg = r.github_workflows;
    const seen = new Set(fx.prs.flatMap((pr) => Object.keys(pr.workflows)));
    const missing = [...seen].filter((w) => !reg[w]);
    assert.deepEqual(missing, [], `${repo}: workflows that ran on PRs but are not mapped`);
  });

  test(`${repo}: each of the 60 PRs selects every check whose path-filtered GitHub workflow ran for it`, () => {
    const failures = [];
    let compared = 0;
    for (const pr of fx.prs) {
      const { selected, unknown } = gen.selectChecks(config, repo, pr.files);
      const sel = new Set(selected);
      for (const [wf, run] of Object.entries(pr.workflows)) {
        if (!run.ran) continue;
        const e = r.github_workflows[wf];
        if (!e || !e.path_filter) continue; // always-on workflows map to the governance jobs and the service checks (plan §3.4)
        const jobs = e.fate === 't1' ? e.jobs : e.pr_jobs || [];
        compared += 1;
        for (const j of jobs) if (!sel.has(j) && !['lane-scope', 'change-suite', 'pr-gate-report', 'collab-handoff'].includes(j)) failures.push(`#${pr.number} ${wf} ran on GitHub, ${j} not selected (files: ${pr.files.slice(0, 5).join(', ')})`);
      }
      if (unknown.length) failures.push(`#${pr.number} unknown paths ${unknown.join(', ')}`);
    }
    assert.deepEqual(failures, []);
    assert.ok(compared > 0, `${repo}: no path-filtered workflow ran in the fixture window`);
  });
}
