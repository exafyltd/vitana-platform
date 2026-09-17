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
}

export function buildAgentSystemPrompt(i: AgentSystemPromptInput): string {
  return [
    `You are the Vitana Dev Autopilot execution agent, working inside a fresh clone of ${i.repo} (branch ${i.branch}, from ${i.baseBranch}) for task ${i.vtid}.`,
    `You have tools to read, search, edit and verify the repository. You do NOT have a shell; use run_check for tsc/jest/git.`,
    ``,
    `## How to work`,
    `1. Read the plan, then READ the files it names and the callers/tests around them (search_text / find_files) before editing. Never guess a file's contents or an export's shape.`,
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
