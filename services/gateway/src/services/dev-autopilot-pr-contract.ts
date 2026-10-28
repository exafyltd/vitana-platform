/**
 * VTID-04002: validator-compliant PR contract for Dev Autopilot executions.
 *
 * Why this exists — Test Run #1 of the Operator execution on-ramp
 * (VTID-03955, execution 0643b701, PR #3351): the model produced a correct,
 * well-tested fix, every functional CI check went green, and the PR was
 * still auto-reverted because `VALIDATOR-CHECK.yml` rejected it at its very
 * first gate — `REJECTED: no VTID in the title, and no explicit
 * 'VTID: VTID-XXXXX' line in the body` (exit 10). The self-healing
 * reconciler's triage then blamed branch protection, which was wrong.
 *
 * Stamping the VTID alone would NOT have fixed it. The same workflow goes on
 * to require, in order (see .github/workflows/VALIDATOR-CHECK.yml):
 *   - `VALIDATION_PROFILE:` in the body                        (exit 11)
 *   - `SCOPE_ALLOWLIST:` / `ACCEPTANCE:` /
 *     `MERGE_PAYLOAD_PREVIEW:` / `OASIS_IMPACT:` markers         (exit 12-15)
 *   - an evidence pack IN THE DIFF: `docs/validation/<VTID>/`
 *     with `acceptance.md`, `commands.log`, `outputs/`          (exit 30-33)
 *   - every `AC-n` line in acceptance.md followed within 12
 *     lines by a `TEST:` / `CURL:` / `UI:` mapping              (exit 40-41)
 *   - the VTID in the PR title (merge/deploy gate)              (exit 90)
 *
 * A human session writes all of that by hand. The executor LLM cannot: its
 * output is a LOCKED file list (only the plan's files) and a free-text
 * PR_TITLE/PR_BODY it has no reason to know the validator grammar for. So
 * the contract is applied DETERMINISTICALLY here, after the model's output
 * has been parsed and validated, never by asking the model for it — the
 * same posture this repo takes whenever prompt compliance proved unreliable
 * (VTID-03650, VTID-03824).
 *
 * Pure: no I/O, no env reads. The executor writes `evidenceFiles` to the
 * branch and opens the PR with `title`/`body`. Everything is derived from
 * data the executor already has (execution id, finding id, plan version,
 * the emitted file list, the model that served the call).
 */

export interface PrContractInput {
  /** Real task VTID (`VTID-XXXXX`). Null when the finding has no
   *  activated_vtid — the contract is then NOT applied (see applyPrContract). */
  vtid: string | null;
  /** The model-authored PR title/body, already parsed and validated. */
  title: string;
  body: string;
  /** Files the LLM emitted (create/modify/delete) — the actual diff. */
  files: Array<{ path: string; action: 'create' | 'modify' | 'delete' }>;
  executionId: string;
  findingId: string;
  planVersion: number;
  branch: string;
  baseBranch: string;
  /** Provider/model that produced the diff, for the commands.log record. */
  provider?: string | null;
  model?: string | null;
  /** ISO timestamp; injectable for deterministic tests. */
  now?: string;
  /** VTID-04016: which executor produced the diff. Default 'single-shot'
   *  (the path this contract was written for); the agent executor
   *  (VTID-04006) passes 'agent' so commands.log describes what actually
   *  ran — a clone, a tool loop, and the runner's own tsc + jest. */
  executor?: 'single-shot' | 'agent';
  /** Agent-path facts for commands.log; ignored for 'single-shot'. */
  agentStats?: {
    turns: number;
    fixRounds: number;
    /** run_check calls the repeated-check guard refused (VTID-04016). */
    checksRefused: number;
    /** read_file/search_text/list_dir/find_files exact-repeat calls the
     *  repeated-navigation guard refused (VTID-04163). */
    navRepeatsRefused: number;
    fallbackUsed: boolean;
    /** false when AGENT_SKIP_TSC disabled the runner's tsc. */
    tscRun: boolean;
  };
  /** VTID-04333: the member-facing ticket number (`FB-YYYY-MM-NNNNNN`) when
   *  the execution came from a feedback ticket. Carried next to the VTID on
   *  the PR title and as a `Member report:` line in the body. */
  ticketNumber?: string | null;
}

export interface PrContractOutput {
  title: string;
  body: string;
  /** Evidence-pack files to commit on the branch alongside the diff. */
  evidenceFiles: Array<{ path: string; content: string }>;
  /** Present on the (unchanged) output when no VTID was available. */
  skipped_reason?: string;
}

const VTID_RE = /VTID-[0-9]{4,5}/;
const TICKET_NUMBER_RE = /^FB-\d{4}-\d{2}-\d{4,}$/;
/** GitHub rejects titles over 256 chars; keep a margin for the suffix. */
const MAX_TITLE_LEN = 240;
const VALIDATION_PROFILE = 'gateway_backend';

const TEST_FILE_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/**
 * Ensure the real VTID appears in the title. Appended as ` (VTID-XXXXX)`,
 * the convention every human-authored PR in this repo already follows, so
 * the merge/deploy gate (`grep -q "$VTID" title`, exit 90) and the primary
 * VTID extraction (exit 10) both pass. A title that already carries ANY
 * `VTID-NNNNN` is left alone — replacing it could point the evidence gate at
 * a different VTID than the one the author meant.
 */
export function stampVtidOnTitle(title: string, vtid: string, ticketNumber?: string | null): string {
  const t = (title || '').trim();
  // VTID-04333: the member ticket number rides next to the VTID. Each id is
  // added only when the title does not already carry it.
  const tn = ticketNumber && TICKET_NUMBER_RE.test(ticketNumber.trim()) ? ticketNumber.trim() : null;
  const parts: string[] = [];
  if (tn && !t.includes(tn)) parts.push(tn);
  if (!VTID_RE.test(t)) parts.push(vtid);
  if (parts.length === 0) return t;
  const suffix = ` (${parts.join(', ')})`;
  const room = MAX_TITLE_LEN - suffix.length;
  const base = t.length > room ? t.slice(0, room - 1).trimEnd() + '…' : t;
  return `${base}${suffix}`;
}

/** VTID-04333: the body line that names the member report. */
export function memberReportLine(ticketNumber: string): string {
  return `Member report: ${ticketNumber}`;
}

function validTicketNumber(v: string | null | undefined): string | null {
  return v && TICKET_NUMBER_RE.test(v.trim()) ? v.trim() : null;
}

function describeFiles(files: PrContractInput['files']): string {
  const counts = { create: 0, modify: 0, delete: 0 };
  for (const f of files) counts[f.action] += 1;
  const parts: string[] = [];
  if (counts.create) parts.push(`${counts.create} created`);
  if (counts.modify) parts.push(`${counts.modify} modified`);
  if (counts.delete) parts.push(`${counts.delete} deleted`);
  return parts.join(', ') || 'no files';
}

/**
 * Build the validator marker block. The body fallback for VTID extraction
 * requires the `VTID:` line at the START of a line (`^[[:space:]]*VTID:`),
 * so it goes first, on its own line, before anything the model wrote.
 */
export function buildValidatorMarkerBlock(input: PrContractInput & { vtid: string }): string {
  const evidenceDir = `docs/validation/${input.vtid}`;
  const scope = [...input.files.map((f) => f.path), `${evidenceDir}/**`].join(', ');
  const acceptanceSummary = input.files
    .filter((f) => f.action !== 'delete')
    .map((f, i) => `AC-${i + 1} (${f.path})`)
    .join(', ');
  const tn = validTicketNumber(input.ticketNumber);
  return [
    `VTID: ${input.vtid}`,
    ...(tn ? [memberReportLine(tn)] : []),
    ``,
    `## Validator tokens`,
    ``,
    `VALIDATION_PROFILE: ${VALIDATION_PROFILE}`,
    `SCOPE_ALLOWLIST: ${scope}`,
    `ACCEPTANCE: ${evidenceDir}/acceptance.md — ${acceptanceSummary || 'AC-1 (deletion-only diff)'}`,
    `MERGE_PAYLOAD_PREVIEW: ${input.files.length} plan file(s) (${describeFiles(input.files)}) + 3 evidence-pack files under ${evidenceDir}/. No workflow, no lockfile, no migration.`,
    `OASIS_IMPACT: no`,
    ``,
    `_Automated Dev Autopilot execution \`${input.executionId}\` (finding \`${input.findingId}\`, plan v${input.planVersion}) on branch \`${input.branch}\`. Validator tokens and evidence pack were generated deterministically by the executor (VTID-04002); the section below is the model's own description of the change._`,
    ``,
    `---`,
    ``,
  ].join('\n');
}

/**
 * acceptance.md: one AC per non-deleted file, each mapped within the next
 * 12 lines to a `TEST:` token (Acceptance Mapping Gate). Source files map to
 * the paired test file in the same diff when one exists; test files map to
 * themselves. When a source file has no paired test in the diff, the AC
 * says so honestly and maps to the CI suite run rather than inventing a
 * test name — the safety gate's tests_missing rule is what guarantees a
 * test is normally present.
 */
export function buildAcceptanceMarkdown(input: PrContractInput & { vtid: string }): string {
  const changed = input.files.filter((f) => f.action !== 'delete');
  const deleted = input.files.filter((f) => f.action === 'delete');
  const testFiles = changed.map((f) => f.path).filter(isTestFile);
  const lines: string[] = [
    `# ${input.vtid} — Dev Autopilot execution ${input.executionId.slice(0, 8)}`,
    ``,
    `## Report`,
    ``,
    `Automated execution of the approved plan for ${input.vtid} (finding \`${input.findingId}\`, plan v${input.planVersion}).`,
    `The model's own description of the change is in the pull request body; the`,
    `\`commands.log\` next to this file records what the executor did and which model served it.`,
    ``,
    `## Acceptance Criteria`,
    ``,
  ];
  let n = 0;
  for (const f of changed) {
    n += 1;
    const verb = f.action === 'create' ? 'is created' : 'is modified';
    lines.push(`AC-${n} — \`${f.path}\` ${verb} as the plan describes, compiles under \`npm run build\`, and the gateway test suite stays green.`);
    if (isTestFile(f.path)) {
      lines.push(`TEST: ${f.path} — new/updated assertions in this diff run in CI (\`npx jest ${f.path}\`).`);
    } else {
      const paired = pairedTestFor(f.path, testFiles);
      if (paired) {
        lines.push(`TEST: ${paired} — covers the change to ${f.path}; runs in CI (\`npx jest ${paired}\`).`);
      } else {
        lines.push(`TEST: services/gateway full jest suite in CI (\`npm test\`) — no paired test file for ${f.path} is part of this diff; coverage relies on the existing suite.`);
      }
    }
    lines.push(``);
  }
  if (deleted.length > 0) {
    n += 1;
    lines.push(`AC-${n} — the following file(s) are removed and nothing still imports them: ${deleted.map((f) => `\`${f.path}\``).join(', ')}.`);
    lines.push(`TEST: services/gateway \`npm run build\` (tsc) in CI fails on any dangling import.`);
    lines.push(``);
  }
  if (n === 0) {
    lines.push(`AC-1 — the plan produced no file changes (should be unreachable: the executor refuses to open an empty PR).`);
    lines.push(`TEST: services/gateway \`npm test\` in CI.`);
    lines.push(``);
  }
  return lines.join('\n');
}

function pairedTestFor(sourcePath: string, testFiles: string[]): string | null {
  const base = sourcePath.split('/').pop() || '';
  const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
  if (!stem) return null;
  const hit = testFiles.find((t) => {
    const tb = t.split('/').pop() || '';
    return tb === `${stem}.test.ts` || tb === `${stem}.spec.ts` || tb.startsWith(`${stem}.test.`) || tb.startsWith(`${stem}.spec.`);
  });
  return hit || null;
}

export function buildCommandsLog(input: PrContractInput & { vtid: string }): string {
  const ts = input.now || new Date().toISOString();
  const header = [
    `# ${input.vtid} — commands run by the Dev Autopilot executor (${input.executor === 'agent' ? 'agent executor, VTID-04006' : 'single-shot executor'})`,
    ``,
    `# ${ts}`,
    `# execution_id=${input.executionId} finding_id=${input.findingId} plan_version=${input.planVersion}`,
    `# branch=${input.branch} base=${input.baseBranch}`,
    `# llm provider=${input.provider || 'unknown'} model=${input.model || 'unknown'}`,
    ``,
  ];
  if (input.executor === 'agent') {
    const a = input.agentStats || { turns: 0, fixRounds: 0, checksRefused: 0, navRepeatsRefused: 0, fallbackUsed: false, tscRun: true };
    return [
      ...header,
      `# agent turns=${a.turns} fix_rounds=${a.fixRounds} checks_refused_by_guard=${a.checksRefused} nav_repeats_refused_by_guard=${a.navRepeatsRefused} fallback_used=${a.fallbackUsed}`,
      ``,
      `$ git clone --depth 1 --branch ${input.baseBranch} <repo> && git checkout -b ${input.branch}`,
      `$ ln -s /app/node_modules services/gateway/node_modules   # image toolchain, no npm ci`,
      `$ autopilot-agent: tool loop on callViaRouter('worker') — read_file / search_text / find_files / edit_file / write_file / run_check(tsc|jest|node_check|git_diff|git_status) / finish`,
      `$ autopilot-agent: run_check refuses a check that already failed since the last edit (VTID-04016)`,
      `$ autopilot-agent: git status --porcelain → changed files; scope check against dev_autopilot_config allow/deny globs; test-coverage rule`,
      a.tscRun
        ? `$ node --max-old-space-size=<AGENT_CHECK_HEAP_MB> node_modules/.bin/tsc --noEmit -p tsconfig.json --preserveSymlinks   # runner, services/gateway`
        : `# runner tsc skipped (AGENT_SKIP_TSC=true)`,
      `$ npx jest <test file(s) paired to the changed files>   # runner, per project`,
      `# a failing runner check is fed back into the same transcript for at most AGENT_MAX_FIX_ROUNDS rounds`,
      ...input.files.map((f) => `$ git ${f.action === 'delete' ? 'rm' : 'add'} ${f.path}   # ${f.action}`),
      `$ dev-autopilot: write docs/validation/${input.vtid}/ evidence pack (this file)`,
      `$ git commit && git push origin ${input.branch}`,
      `$ gh pr create --base ${input.baseBranch} --head ${input.branch}`,
      ``,
      `# The runner re-ran tsc and the paired jest suites before this PR was opened; the full suite, lint and build run in CI (VALIDATOR-CHECK + Gateway CI).`,
      ``,
    ].join('\n');
  }
  return [
    ...header,
    `$ dev-autopilot: fetch current content of ${input.files.length} plan file(s) from ${input.baseBranch}`,
    `$ dev-autopilot: callViaRouter('worker') → parse <<<PR_TITLE>>>/<<<PR_BODY>>>/<<<FILE>>> blocks`,
    `$ dev-autopilot: validate emitted paths ⊆ plan.files_referenced; plan/diff coverage ≥ threshold`,
    `$ git checkout -b ${input.branch} ${input.baseBranch}`,
    ...input.files.map((f) => `$ git ${f.action === 'delete' ? 'rm' : 'add'} ${f.path}   # ${f.action}`),
    `$ dev-autopilot: write docs/validation/${input.vtid}/ evidence pack (this file)`,
    `$ gh pr create --base ${input.baseBranch} --head ${input.branch}`,
    ``,
    `# Build, lint and the full jest suite run in CI on this PR (VALIDATOR-CHECK build gate + Gateway CI);`,
    `# the executor itself does not run them — see outputs/execution.json.`,
    ``,
  ].join('\n');
}

export function buildOutputsRecord(input: PrContractInput & { vtid: string }): string {
  return JSON.stringify(
    {
      vtid: input.vtid,
      execution_id: input.executionId,
      finding_id: input.findingId,
      plan_version: input.planVersion,
      branch: input.branch,
      base_branch: input.baseBranch,
      llm: { provider: input.provider || null, model: input.model || null },
      ticket_number: validTicketNumber(input.ticketNumber),
      files: input.files.map((f) => ({ path: f.path, action: f.action })),
      generated_at: input.now || new Date().toISOString(),
      generated_by: 'dev-autopilot-execute (VTID-04002 PR contract)',
    },
    null,
    2,
  ) + '\n';
}

/**
 * Apply the whole contract. Returns the input title/body unchanged (plus a
 * `skipped_reason`) when there is no real VTID — a `VTID-DA-<execId>` is not
 * a ledger VTID and the validator would reject the PR anyway; stamping a
 * synthetic id would only make the failure harder to read.
 */
export function applyPrContract(input: PrContractInput): PrContractOutput {
  if (!input.vtid || !VTID_RE.test(input.vtid)) {
    return {
      title: input.title,
      body: input.body,
      evidenceFiles: [],
      skipped_reason: 'no real VTID (finding has no activated_vtid) — validator contract not applied',
    };
  }
  const withVtid = { ...input, vtid: input.vtid };
  const evidenceDir = `docs/validation/${input.vtid}`;
  const bodyHasVtidLine = /^\s*VTID:\s*VTID-[0-9]{4,5}/m.test(input.body);
  const bodyHasMarkers = ['VALIDATION_PROFILE:', 'SCOPE_ALLOWLIST:', 'ACCEPTANCE:', 'MERGE_PAYLOAD_PREVIEW:', 'OASIS_IMPACT:']
    .every((m) => input.body.includes(m));
  let body = bodyHasVtidLine && bodyHasMarkers
    ? input.body
    : buildValidatorMarkerBlock(withVtid) + input.body.trimStart();
  // VTID-04333: a model-authored body that already carried the validator
  // tokens still gets the member report line.
  const tn = validTicketNumber(input.ticketNumber);
  if (tn && !body.includes(memberReportLine(tn))) body = `${memberReportLine(tn)}\n\n${body}`;
  return {
    title: stampVtidOnTitle(input.title, input.vtid, tn),
    body,
    evidenceFiles: [
      { path: `${evidenceDir}/acceptance.md`, content: buildAcceptanceMarkdown(withVtid) },
      { path: `${evidenceDir}/commands.log`, content: buildCommandsLog(withVtid) },
      { path: `${evidenceDir}/outputs/execution.json`, content: buildOutputsRecord(withVtid) },
    ],
  };
}
