/**
 * VTID-04758 — RepoWise + Graphify actually usable in Claude Code sessions.
 *
 * Measured before this change (2026-10-01): no session had either tool. The
 * SessionStart hook rebuilt RepoWise inside its 300 s timeout although a full
 * vitana-platform index takes ~10 min, session clones are shallow (~100
 * commits) so even a finished local build had almost no git history, the
 * committed `.repowise/decisions.yaml` made the hook choose `update` on a
 * fresh clone, and a multi-repo session (cwd /home/user) never ran the hook.
 *
 * Contract pinned here:
 *   - CODEINTEL-INDEX.yml ships the full-history RepoWise index as a session
 *     seed, before the latest/ pointer, recorded in the manifest;
 *   - scripts/codeintel/session-setup.sh installs in the foreground, indexes
 *     in a detached flock-guarded worker, re-points the seeded index at this
 *     checkout, never writes tracked editor files, and can register user-scope
 *     MCP servers for multi-repo sessions;
 *   - the hook is a thin, remote-only delegate.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/CODEINTEL-INDEX.yml'), 'utf8');
const SCRIPT_PATH = path.join(ROOT, 'scripts/codeintel/session-setup.sh');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');
const HOOK_PATH = path.join(ROOT, '.claude/hooks/session-start-codeintel-setup.sh');
const HOOK = fs.readFileSync(HOOK_PATH, 'utf8');

describe('VTID-04758 CODEINTEL-INDEX publishes a RepoWise session seed', () => {
  const pkg = WF.slice(WF.indexOf('name: Package the session seed'), WF.indexOf('name: Configure AWS credentials'));
  const publish = WF.slice(WF.indexOf('name: Publish to S3'));

  it('packages the index self-contained, without the committed decisions file or the export', () => {
    expect(pkg).toContain('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(pkg).toContain('tar -czf bundle/repowise-index.tar.gz -C src');
    expect(pkg).toContain('--exclude=.repowise/decisions.yaml');
    expect(pkg).toContain('--exclude=.repowise/export');
    expect(pkg).toContain(".repowise\n");
  });

  it('builds the seed with editor files off and a consistent config fingerprint', () => {
    // Any config change makes `repowise update` re-render every page. init
    // stamps its fingerprint before writing --no-claude-md/--no-agents into
    // config.yaml, so CI re-stamps (measured: first update 6703 pages -> 1).
    expect(WF).toContain('repowise init --no-prose -y --no-claude-md --no-agents');
    const init = WF.indexOf('repowise init --no-prose -y --no-claude-md --no-agents');
    const restamp = WF.indexOf('python ../tools/scripts/codeintel/repowise_restamp_config.py .');
    const exp = WF.indexOf('repowise export --format json --full');
    expect(restamp).toBeGreaterThan(init);
    expect(exp).toBeGreaterThan(restamp);
    expect(pkg).toContain('--exclude=.repowise/parse_cache.pkl');
  });

  it('re-stamps with RepoWise’s own fingerprint functions', () => {
    const py = fs.readFileSync(path.join(ROOT, 'scripts/codeintel/repowise_restamp_config.py'), 'utf8');
    expect(py).toContain('from repowise.cli.helpers import config_fingerprint, load_config');
    expect(py).toContain('from repowise.core.repo_config import config_dependency_fingerprints');
    expect(py).toContain('state["config_fingerprint"] = config_fingerprint(repo)');
  });

  it('records the seed in the manifest with the build root the session rewrites', () => {
    expect(pkg).toContain('.session_seed = {format: 1, source_root: $root');
    expect(pkg).toContain('files: {repowise: "repowise-index.tar.gz"}');
    expect(pkg).toContain('--arg root "$GITHUB_WORKSPACE/src"');
  });

  it('uploads the seed under <sha>/ before latest/manifest.json is moved', () => {
    const seed = publish.indexOf('repowise-index.tar.gz "$PREFIX/repowise-index.tar.gz"');
    const latest = publish.indexOf('/latest/manifest.json');
    expect(seed).toBeGreaterThan(-1);
    expect(latest).toBeGreaterThan(seed);
  });

  it('keeps the existing bundle contract (consumers only need sha + files.graph/risk)', () => {
    expect(WF).toContain('node tools/scripts/codeintel/build-code-index.mjs');
    expect(publish).toContain('$PREFIX/graph-index.json.gz');
    expect(publish).toContain('$PREFIX/risk-index.json.gz');
  });
});

describe('VTID-04758 scripts/codeintel/session-setup.sh', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('bash', ['-n', HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('indexes in a detached, lock-guarded worker so the hook never times out mid-build', () => {
    expect(SCRIPT).toContain('setsid nohup bash "$SELF" --worker');
    expect(SCRIPT).toContain('flock -n 9');
  });

  it('seeds from the CI index, re-points it at this checkout, then updates incrementally', () => {
    expect(SCRIPT).toContain('{slug}/latest/manifest.json');
    expect(SCRIPT).toContain('"update repositories set local_path = ?, name = ?"');
    expect(SCRIPT).toContain('restamp_config "$repo"');
    // The seed lands before the Graphify build, so RepoWise is queryable in seconds.
    expect(SCRIPT.indexOf('seed_repowise "$repo" "$slug"')).toBeLessThan(SCRIPT.indexOf('graphify update "$repo" --no-cluster'));
    expect(SCRIPT).toContain('repowise update "$repo" --no-workspace --no-agents -y');
    expect(SCRIPT).toContain("--exclude='.repowise/decisions.yaml'");
  });

  it('judges an index by pages for THIS checkout, not by the committed .repowise/ directory', () => {
    expect(SCRIPT).toContain('where r.local_path = ?');
    expect(SCRIPT).not.toMatch(/\[ -d "\$\w+\/\.repowise" \]/);
  });

  it('never writes tracked editor files from a session, and edits the seed config only when it must', () => {
    expect(SCRIPT).toContain('"claude_md": False, "agents_md": False');
    expect(SCRIPT).toContain('if ef.get("claude_md") is not False or ef.get("agents_md") is not False:');
    expect(SCRIPT).toContain('--no-editor-setup --no-claude-md');
  });

  it('puts the tools on the default PATH (the committed .mcp.json runs bare "repowise")', () => {
    expect(SCRIPT).toContain('ln -sf "$HOME/.local/bin/$t" "$dir/$t"');
  });

  it('registers user-scope MCP servers on request, for multi-repo sessions', () => {
    expect(SCRIPT).toContain('name="repowise-$(basename "$repo")"');
    // Name BEFORE -e: `-e` is variadic and swallowed the name when it came first
    // ("Invalid environment variable format: repowise-vitana-platform").
    expect(SCRIPT).toContain('claude mcp add --scope user "$name" -e REPOWISE_TELEMETRY_DISABLED=1 --');
  });

  it("keeps graphify's merge driver out of the working tree (.git/info/attributes, not .gitattributes)", () => {
    expect(SCRIPT).toContain('rev-parse --git-path info/attributes');
    expect(SCRIPT).toContain('if [ -n "$backup" ]; then cp -p "$backup" "$ga"; else rm -f "$ga"; fi');
    expect(SCRIPT).not.toMatch(/^\s*graphify hook install/m);
  });

  it('reports never-run status without installing or touching anything', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'codeintel-'));
    const out = execFileSync('bash', [SCRIPT_PATH, '--status', '/nonexistent/some-repo'], {
      env: { ...process.env, CODEINTEL_STATE_DIR: state },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    expect(JSON.parse(out)).toEqual({ repo: '/nonexistent/some-repo', state: 'never-run' });
  });
});

describe('VTID-04758 SessionStart hook', () => {
  it('runs only in remote sessions and delegates to the script', () => {
    expect(HOOK).toContain('[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0');
    expect(HOOK).toContain('SETUP="$REPO_DIR/scripts/codeintel/session-setup.sh"');
    expect(HOOK).not.toContain('repowise init');
  });

  it('is still registered as a SessionStart hook', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
    const cmds = (settings.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((h) => h.hooks.map((x) => x.command));
    expect(cmds.some((c) => c.includes('session-start-codeintel-setup.sh'))).toBe(true);
  });
});
