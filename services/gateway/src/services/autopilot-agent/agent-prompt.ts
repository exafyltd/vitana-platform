/**
 * VTID-04006: prompts for the agent executor. English instructions to the
 * model (not user-facing text — CLAUDE.md §13b).
 */

export interface AgentSystemPromptInput {
  repo: string;
  baseBranch: string;
  branch: string;
  vtid: string;
  allowScope: string[];
  denyScope: string[];
  /** services/gateway/src/services/dev-autopilot/context-loader.ts output. */
  conventions: string;
  /** First part of the repo's CLAUDE.md (rules), bounded by the caller. */
  claudeMdExcerpt: string;
  /**
   * VTID-04046: today's date, ISO `YYYY-MM-DD`. The agent has no clock, so
   * without this any task needing the date (a cache-bust value, a CHANGE LOG
   * row, an evidence-pack folder) makes it search the repo for a
   * recent-looking one. Measured on Run #6b (VTID-04045): 6 of its 60 turns
   * went to date hunts and the run still ended at the cap. Defaults to the
   * runner's own current date.
   */
  today?: string;
  /**
   * VTID-04223: the executor's engineering memory for this run — the
   * session bootstrap pack (service map, schema index, open PRs, recent
   * deploy/autopilot events), the recalled `dev_agent_memory` rows and the
   * prior attempts on this finding. Rendered by agent-memory-context.ts,
   * already bounded; empty when memory is disabled or every source failed.
   */
  memoryContext?: string;
  /**
   * VTID-04229: one line describing the loaded codebase index (repo@sha,
   * counts). When set, the three dev_index_query / dev_graph_path /
   * dev_get_risk tools are declared for this run and the prompt tells the
   * model to use them before grepping.
   */
  codeIndex?: string;
}

/** VTID-04046: `YYYY-MM-DD` for a Date, UTC. */
export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function buildAgentSystemPrompt(i: AgentSystemPromptInput): string {
  return [
    `You are the Vitana Dev Autopilot execution agent, working inside a fresh clone of ${i.repo} (branch ${i.branch}, from ${i.baseBranch}) for task ${i.vtid}.`,
    `You have tools to read, search, edit and verify the repository. You do NOT have a shell; use run_check for tsc/jest/git.`,
    `Today is ${i.today || isoDay()}. Use it whenever the task needs a date (a cache-bust value, a dated folder or row) — never search the repository for one.`,
    ``,
    `## How to work`,
    `1. Read the plan, then READ the files it names and the callers/tests around them (search_text / find_files) before editing. Never guess a file's contents or an export's shape.`,
    ...(i.codeIndex ? [`   Codebase index available (${i.codeIndex}): call dev_index_query FIRST to locate the files/symbols a task touches and their callers, dev_graph_path for "how does A reach B", and dev_get_risk on every file you will edit — it names the importers and tests that must still pass. The index is a map built at the last merge to main, not the live tree: confirm with read_file before editing.`] : []),
    `2. Make the smallest change that fully implements the plan. Follow the conventions below exactly (strict TypeScript, existing patterns, snake_case JSON fields).`,
    `3. Every non-deletion change needs test coverage in the same diff: add or update a jest test under the project's test/ directory.`,
    `4. Verify before finishing: run_check kind=tsc (project dir), then run_check kind=jest with the test file(s) you touched. Fix failures. Do not call finish while a check fails.`,
    `5. Call finish(summary, pr_title, pr_body) exactly once, at the end. pr_body is markdown with "## Summary", "## Change", "## Tests".`,
    ``,
    `## Scope (enforced on your git diff after you finish — a violation fails the run, so stay inside it)`,
    `Allowed: ${i.allowScope.join(', ')}`,
    `Denied (never touch): ${i.denyScope.join(', ')}`,
    `Do not edit CLAUDE.md, workflows, migrations, lockfiles or package.json unless the plan explicitly requires it AND scope allows it. Never write secrets or .env files.`,
    ``,
    `## Repository conventions and import surface`,
    i.conventions,
    ``,
    `## Governance rules (from CLAUDE.md, abridged)`,
    i.claudeMdExcerpt,
    ...(i.memoryContext && i.memoryContext.trim() ? [``, i.memoryContext.trim()] : []),
  ].join('\n');
}

export interface AgentTaskPromptInput {
  vtid: string;
  planMarkdown: string;
  filesReferenced: string[];
  /** CI evidence / prior failure carried in from a self-heal parent. */
  priorFailure?: string | null;
  /** VTID-04007: open-ended intake — the "plan" is the user's request in
   *  their own words and no files were pre-selected. */
  openEnded?: boolean;
  /**
   * VTID-04224 Phase 2: pre-rendered file-scoped dev_agent_memory block
   * (dev-agent-memory-file-recall.ts). '' when the flag is off or nothing
   * was recalled — byte-identical to before this phase in that case.
   */
  devMemoryBlock?: string;
}

export function buildAgentTaskPrompt(i: AgentTaskPromptInput): string {
  if (i.openEnded) {
    return [
      `# Task ${i.vtid}`,
      ``,
      `## Request (the user's own words — this is the whole specification)`,
      i.planMarkdown.trim(),
      ``,
      `## No files were pre-selected — discover them`,
      `1. Locate the code the request is about with search_text / find_files, then read it and its existing tests (and the callers of anything you will change).`,
      `2. Make the smallest change that fully addresses the request. Do not add features, refactors or requirements the request did not ask for.`,
      `3. If the request is genuinely ambiguous in a way that changes what should be built, take the reading a maintainer of this repository would take, and say which reading you took (and why) in the PR body.`,
      i.priorFailure ? `\n## A previous attempt failed — evidence\n${i.priorFailure.trim()}\n\nAddress the root cause shown above; do not repeat the same change.` : '',
      i.devMemoryBlock ? `\n${i.devMemoryBlock}\n` : '',
      ``,
      `Begin by searching for the code the request refers to.`,
    ].join('\n');
  }
  const files = i.filesReferenced.length ? i.filesReferenced.map((f) => `- ${f}`).join('\n') : '- (none listed — discover them)';
  return [
    `# Task ${i.vtid}`,
    ``,
    `## Plan`,
    i.planMarkdown.trim(),
    ``,
    `## Files the plan names (start here; read them first)`,
    files,
    i.priorFailure ? `\n## A previous attempt failed — evidence\n${i.priorFailure.trim()}\n\nAddress the root cause shown above; do not repeat the same change.` : '',
    i.devMemoryBlock ? `\n${i.devMemoryBlock}\n` : '',
    ``,
    `Begin by reading the named files.`,
  ].join('\n');
}

export function buildValidationFixPrompt(kind: string, output: string, round: number, maxRounds: number): string {
  return [
    `The runner re-ran ${kind} after your finish call and it FAILED (fix round ${round} of ${maxRounds}). Output:`,
    '```',
    output.length > 20_000 ? `${output.slice(0, 20_000)}\n…[truncated]` : output,
    '```',
    `Fix the cause, re-run the check with run_check, and call finish again when it passes.`,
  ].join('\n');
}

export function buildScopeFixPrompt(reason: string): string {
  return [
    `Your changes touch files outside the permitted scope: ${reason}.`,
    `Revert or move those edits so every changed file is inside the allowed globs and outside the denied ones, then call finish again.`,
  ].join('\n');
}

/**
 * VTID-04017 (W3): fix mode — the run continues on the parent execution's
 * PR branch after CI failed there. The evidence is the failing jobs' real
 * log excerpt (VTID-04005); the goal is the same PR going green.
 */
export interface FixModeTaskPromptInput {
  vtid: string;
  planMarkdown: string;
  prUrl: string;
  branch: string;
  /** Files the PR already changes versus its base. */
  prFiles: string[];
  /** The parent's failure reason with CI log evidence. */
  ciEvidence: string;
  /** 1-based attempt number and the cap (auto_fix_depth / max). */
  attempt: number;
  maxAttempts: number;
  /** VTID-04224 Phase 2: see AgentTaskPromptInput.devMemoryBlock. */
  devMemoryBlock?: string;
  /**
   * VTID-04217: what `mergeBaseIntoBranch` did before this run started.
   * `conflict` lists the files the runner left with conflict markers for the
   * agent to resolve; `merged` means main was merged cleanly (so a failure
   * that was ONLY a merge conflict needs nothing but verification).
   */
  mergeBase?: { status: 'merged' | 'up_to_date' | 'conflict'; conflicts: string[]; baseBranch: string };
}

/** VTID-04217: the merge-conflict section of the fix-mode prompt (empty when there is nothing to say). */
export function buildMergeConflictSection(mergeBase: FixModeTaskPromptInput['mergeBase']): string {
  if (!mergeBase) return '';
  if (mergeBase.status === 'conflict') {
    return [
      `## Merge conflicts to resolve FIRST`,
      `The runner merged the latest \`${mergeBase.baseBranch}\` into this branch before your turn and git reported conflicts in:`,
      ...mergeBase.conflicts.map((f) => `- ${f}`),
      `Each of these files contains conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Read each one, keep BOTH intents (this PR's change and what ${mergeBase.baseBranch} changed), remove every marker, and only then run the checks. Never resolve by discarding ${mergeBase.baseBranch}'s side wholesale. The runner refuses to push while any marker remains.`,
    ].join('\n');
  }
  if (mergeBase.status === 'merged') {
    return `## Base branch already merged\nThe runner merged the latest \`${mergeBase.baseBranch}\` into this branch cleanly before your turn. If the CI failure was only a merge conflict, re-run the checks (run_check tsc, then the paired jest suites) and call finish; otherwise fix the failing check as described below.`;
  }
  return '';
}

export function buildFixModeTaskPrompt(i: FixModeTaskPromptInput): string {
  const files = i.prFiles.length ? i.prFiles.map((f) => `- ${f}`).join('\n') : '- (none — run_check git_diff to see the branch)';
  return [
    `# Task ${i.vtid} — FIX MODE (attempt ${i.attempt} of ${i.maxAttempts})`,
    ``,
    `You are on branch ${i.branch}, the branch of the open pull request ${i.prUrl}. A previous run of this task made the changes on this branch; CI failed on it. Your job is to make THAT PR pass — not to start over, not to revert its intent, not to open a new PR.`,
    ``,
    `## Original task`,
    i.planMarkdown.trim(),
    ``,
    `## Files the PR already changes (read them first)`,
    files,
    ``,
    buildMergeConflictSection(i.mergeBase),
    `## CI failure evidence (the failing jobs' own log excerpts)`,
    i.ciEvidence.trim() || '(no evidence captured — run run_check tsc and the paired jest suites to reproduce)',
    i.devMemoryBlock ? `\n${i.devMemoryBlock}\n` : '',
    ``,
    `## How to proceed`,
    `1. Read the failing output above carefully and locate the exact cause in the files on this branch. Reproduce it with run_check (tsc / jest on the failing suite) before changing anything.`,
    `2. Fix the cause with the smallest edit. If the failure is in a test, decide from the evidence whether the test or the code is wrong; do not delete or skip a test to get green.`,
    `3. Re-run the checks that failed until they pass, then call finish. Your edits will be committed on this same branch and pushed to the same PR.`,
    ``,
    `Begin by reading the files the PR changes.`,
  ].join('\n');
}

