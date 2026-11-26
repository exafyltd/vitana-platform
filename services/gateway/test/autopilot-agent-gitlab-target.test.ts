/**
 * GitLab-native repair target (services/autopilot-agent/gitlab-target.ts).
 *
 * A Dev Autopilot execution can now repair a failed GitLab merge-request pipeline on the merge request's own branch. These tests pin
 * what makes an execution GitLab-hosted, what a valid target is, and how the executor reaches GitLab. Two properties matter for safety:
 *   - a row that merely CLAIMS to be GitLab-hosted (any `host: 'gitlab'` or any `gitlab` block, valid or not) is GitLab-hosted for every
 *     guard, so a malformed row can never fall through to the GitHub paths (PR close, branch delete, PR open);
 *   - the token is never part of an error, and the clone URL is the only place it appears.
 */
import {
  GITLAB_EXECUTOR_TOKEN_ENV,
  gitlabExecutorConfig,
  gitlabRemoteUrl,
  isGitlabExecution,
  parseGitlabTarget,
  type GitlabTarget,
} from '../src/services/autopilot-agent/gitlab-target';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'glpat-executor-token-not-real-0000';

function target(over: Partial<GitlabTarget> = {}): GitlabTarget {
  return {
    project_path: 'vitana/vitana-platform',
    mr_iid: 12,
    mr_url: 'https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/12',
    source_branch: 'delivery-loop/fix-greeting',
    target_branch: 'main',
    pipeline_id: 31,
    sha: SHA,
    work_key: 'repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef',
    dispatch_key: 'intent:repair:vitana/vitana-platform|delivery-loop/fix-greeting|0123456789abcdef:1',
    ...over,
  };
}
const meta = (over: Partial<GitlabTarget> = {}) => ({ host: 'gitlab', executor: 'agent', gitlab: target(over) });

describe('isGitlabExecution', () => {
  it('is true for host gitlab, and for any row that carries a gitlab block, even a malformed one', () => {
    expect(isGitlabExecution({ metadata: meta() })).toBe(true);
    expect(isGitlabExecution({ metadata: { host: 'gitlab' } })).toBe(true); // no target at all: still GitLab-hosted
    expect(isGitlabExecution({ metadata: { gitlab: { nonsense: true } } })).toBe(true); // a block without the host flag
    expect(isGitlabExecution({ metadata: { host: 'GitLab' } })).toBe(true); // case does not matter
  });

  it('is false for GitHub executions, rows without metadata, and null', () => {
    expect(isGitlabExecution({ metadata: { executor: 'agent', fix_mode: { branch: 'dev-autopilot/abc' } } })).toBe(false);
    expect(isGitlabExecution({ metadata: {} })).toBe(false);
    expect(isGitlabExecution({ metadata: null })).toBe(false);
    expect(isGitlabExecution({})).toBe(false);
    expect(isGitlabExecution(null)).toBe(false);
    expect(isGitlabExecution(undefined)).toBe(false);
    expect(isGitlabExecution({ metadata: { host: 'github' } })).toBe(false);
  });
});

describe('parseGitlabTarget', () => {
  it('accepts a complete target and returns it unchanged', () => {
    const r = parseGitlabTarget(meta());
    expect(r).toEqual({ ok: true, target: target() });
  });

  it('accepts a merge request without a URL', () => {
    expect(parseGitlabTarget(meta({ mr_url: null })).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no gitlab block', { host: 'gitlab' }],
    ['a project path without a group', { gitlab: target({ project_path: 'vitana-platform' }) }],
    ['a project path that climbs', { gitlab: target({ project_path: 'vitana/../secrets' }) }],
    ['a project path with a URL in it', { gitlab: target({ project_path: 'https://evil.test/x' }) }],
    ['a merge request iid of 0', { gitlab: target({ mr_iid: 0 }) }],
    ['a fractional merge request iid', { gitlab: target({ mr_iid: 1.5 }) }],
    ['a pipeline id that is not a number', { gitlab: { ...target(), pipeline_id: '31' } }],
    ['a short sha', { gitlab: target({ sha: 'abc123' }) }],
    ['an upper-case sha', { gitlab: target({ sha: SHA.toUpperCase() }) }],
    ['the source branch main', { gitlab: target({ source_branch: 'main' }) }],
    ['the source branch master', { gitlab: target({ source_branch: 'master' }) }],
    ['the source branch equal to the target branch', { gitlab: target({ source_branch: 'release/1', target_branch: 'release/1' }) }],
    ['a branch that starts with a dash (an option to git)', { gitlab: target({ source_branch: '--upload-pack=x' }) }],
    ['a branch with a space', { gitlab: target({ source_branch: 'delivery-loop/a b' }) }],
    ['a branch with ..', { gitlab: target({ source_branch: 'delivery-loop/../main' }) }],
    ['a branch ending in .lock', { gitlab: target({ source_branch: 'delivery-loop/x.lock' }) }],
    ['an empty work key', { gitlab: target({ work_key: '' }) }],
    ['an empty dispatch key', { gitlab: target({ dispatch_key: '' }) }],
    ['a merge request URL that is not https', { gitlab: target({ mr_url: 'http://gitlab.test/x' }) }],
  ])('refuses %s', (_why, gitlab) => {
    const r = parseGitlabTarget({ host: 'gitlab', ...gitlab });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\S/);
  });

  it('refuses metadata that is not GitLab-hosted', () => {
    expect(parseGitlabTarget({ executor: 'agent' }).ok).toBe(false);
    expect(parseGitlabTarget(null).ok).toBe(false);
  });
});

describe('gitlabExecutorConfig and gitlabRemoteUrl', () => {
  it('needs an https GitLab API URL and the executor token, and gives the origin', () => {
    expect(gitlabExecutorConfig({ GITLAB_API_URL: 'https://gitlab.vitanaland.com/api/v4', [GITLAB_EXECUTOR_TOKEN_ENV]: TOKEN })).toEqual({
      ok: true,
      origin: 'https://gitlab.vitanaland.com',
      token: TOKEN,
    });
  });

  it.each<[string, Record<string, string>]>([
    ['no API URL', { [GITLAB_EXECUTOR_TOKEN_ENV]: TOKEN }],
    ['no token', { GITLAB_API_URL: 'https://gitlab.vitanaland.com/api/v4' }],
    ['an http API URL', { GITLAB_API_URL: 'http://gitlab.vitanaland.com/api/v4', [GITLAB_EXECUTOR_TOKEN_ENV]: TOKEN }],
    ['an API URL that is not a URL', { GITLAB_API_URL: 'gitlab', [GITLAB_EXECUTOR_TOKEN_ENV]: TOKEN }],
  ])('refuses %s, and the refusal never carries the token', (_why, env) => {
    const r = gitlabExecutorConfig(env as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('does not take the delivery loop\'s read token for pushing: only the executor token counts', () => {
    expect(gitlabExecutorConfig({ GITLAB_API_URL: 'https://gitlab.vitanaland.com/api/v4', GITLAB_API_TOKEN: TOKEN } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it('builds the oauth2 clone URL of the project, with the token URL-encoded', () => {
    expect(gitlabRemoteUrl('https://gitlab.vitanaland.com', 'vitana/vitana-platform', TOKEN)).toBe(
      `https://oauth2:${TOKEN}@gitlab.vitanaland.com/vitana/vitana-platform.git`,
    );
    expect(gitlabRemoteUrl('https://gitlab.vitanaland.com', 'vitana/rehearsal', 'a/b:c@d')).toBe('https://oauth2:a%2Fb%3Ac%40d@gitlab.vitanaland.com/vitana/rehearsal.git');
  });
});
