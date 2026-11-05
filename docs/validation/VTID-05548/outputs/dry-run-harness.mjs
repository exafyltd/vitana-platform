// B3 evidence harness (VTID-05548, lane agentic-delivery/github-bridge): the bridge's dry run over a read-only snapshot
// of the open pull requests of both repositories, against an empty GitLab (no GitLab instance exists yet).
//   gh api --paginate "repos/exafyltd/vitana-platform/pulls?state=open&per_page=100" > platform.json   (GET only)
//   gh api --paginate "repos/exafyltd/vitana-v1/pulls?state=open&per_page=100" > v1.json
//   node docs/validation/VTID-05548/outputs/dry-run-harness.mjs platform.json v1.json "<snapshot time>" > outputs/dry-run.txt
// GitHub's pull request list is served from the snapshot and GitLab is an empty recording fake; the GitHub branch heads
// are the pull request heads of the snapshot. Every git operation other than ls-remote throws, and the harness fails if
// any API call was a write, so the output proves that the dry run writes nothing. Prints only the head branch, the
// number and the planned actions of each pull request (no titles, no bodies), then counts per repository.
import { readFileSync } from 'node:fs';
import { fakeFetch } from '../../../../scripts/eng/testing/fake-fetch.mjs';
import { createClient } from '../../../../scripts/eng/gitlab-api.mjs';
import { BRIDGE_REPOS, createGitHubClient, emptyState, isBridgedBranch, tick } from '../../../../scripts/eng/github-bridge.mjs';

const [platformFile, v1File, takenAt = 'unknown'] = process.argv.slice(2);
const load = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/\]\s*\[/g, ',')); // gh --paginate prints one array per page
const snapshot = { 'exafyltd/vitana-platform': load(platformFile), 'exafyltd/vitana-v1': load(v1File) };
const f = fakeFetch();
for (const [repo, pulls] of Object.entries(snapshot)) {
  f.route('GET', `/repos/${repo}/pulls`, (call) => {
    const base = call.query.base?.[0];
    const head = call.query.head?.[0];
    return { json: pulls.filter((p) => p.state === 'open' && (!base || p.base?.ref === base) && (!head || `${p.head?.repo?.owner?.login}:${p.head?.ref}` === head)) };
  });
}
f.route('GET', '/api/v4/user', { json: { id: 1, username: 'bridge (dry run)' } });
f.route('GET', /^\/api\/v4\/projects\/[^/]+\/merge_requests$/, { json: [] });
const sameRepo = (p, repo) => String(p.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase();
const git = {
  lsRemote(url) {
    const repo = Object.keys(snapshot).find((r) => url === `github:${r}`);
    if (!repo) return new Map(); // GitLab: empty
    return new Map(snapshot[repo].filter((p) => sameRepo(p, repo) && isBridgedBranch(p.head?.ref)).map((p) => [p.head.ref, p.head.sha]));
  },
};
for (const op of ['fetchBranch', 'fetchRef', 'fetchGitLabBranch', 'fetchGitLabMain', 'fetchMergeRequestHead', 'push']) {
  git[op] = () => { throw new Error(`dry run called git ${op}`); };
}
git.hasCommit = () => false; // an empty cache, as on a fresh host
git.isAncestor = () => null;
git.parents = () => null;
git.withoutMainMerges = () => null;
git.mainHead = () => null; // GitLab is empty
const repos = BRIDGE_REPOS.map(({ github, gitlab }) => ({ github, gitlab, githubGitUrl: `github:${github}`, gitlabGitUrl: `gitlab:${gitlab}` }));
const res = await tick({
  repos, git, dryRun: true, state: emptyState(), gitlabWebUrl: 'https://gitlab.vitanaland.com', log: () => {},
  github: createGitHubClient({ token: 'dry-run-token-not-used', baseUrl: 'https://api.github.com', fetch: f }),
  gitlab: createClient({ baseUrl: 'https://gitlab.vitanaland.com', token: 'dry-run-token-not-used', fetch: f }),
});
f.assertNoWrites();
if (res.errors.length) throw new Error(`dry run errors: ${JSON.stringify(res.errors)}`);

const lines = [
  '# Bridge dry run, read-only, over the open pull requests of both repositories (VTID-05548, task B3). It plans the',
  '# merge requests; the returning statuses of plan §8.1 step 4 need a GitLab instance and are not part of it.',
  `# Snapshot of GitHub's open pull requests taken ${takenAt} with gh api (GET only); GitLab empty (no instance exists yet).`,
  `# API calls: ${f.calls.length}, all GET (no write). Git: ls-remote only (served from the snapshot). State: not written.`,
  '# One line per pull request: repository #number head-branch: planned actions, or why it is ignored.',
  '',
];
const summary = [];
for (const { github } of BRIDGE_REPOS) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] ?? 0) + 1; };
  for (const p of [...snapshot[github]].sort((a, b) => a.number - b.number)) {
    let why = null;
    if (!sameRepo(p, github)) why = 'ignored: from a fork';
    else if (p.base?.ref !== 'main') why = 'ignored: base is not main';
    else if (!isBridgedBranch(p.head?.ref)) why = `ignored: head branch is not kiro/* or claude/* (${String(p.head?.ref).split('/')[0]}/...)`;
    if (why) {
      bump(why.split(' (')[0]);
      lines.push(`${github} #${p.number} ${p.head?.ref}: ${why}`);
      continue;
    }
    const acts = res.actions.filter((a) => a.repo === github && (a.pr === p.number || (a.pr === undefined && a.branch === p.head.ref))).map((a) => a.action);
    for (const a of acts) bump(a);
    lines.push(`${github} #${p.number} ${p.head.ref}: ${acts.join(', ') || 'nothing to do'}`);
  }
  summary.push(`${github}: ${snapshot[github].length} open pull requests; ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join('; ')}`);
}
lines.push('', '# Counts', ...summary, `total planned actions: ${res.actions.length}; errors: ${res.errors.length}`);
process.stdout.write(`${lines.join('\n')}\n`);
