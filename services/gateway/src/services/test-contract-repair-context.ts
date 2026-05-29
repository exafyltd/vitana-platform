/**
 * VTID-02967 (PR-L4): Test Contract Known-Good Recovery context builder.
 *
 * Phase 4 of the Test Contract Backbone plan. When the failure scanner
 * is about to allocate a repair VTID for a failing contract, it asks
 * this builder for "what did the file look like the last time the test
 * passed?" — and includes both versions in the LLM repair spec. The
 * LLM goes from "guess at a fix" to "explain why this diff broke the
 * contract, then revert / compensate / propose a deliberate behavior
 * change".
 *
 * The recommendation field tells the LLM whether the diff is small
 * enough that direct revert (`recover_to_last_passing_sha`) is the
 * obvious choice, or whether the change is large and needs investigation.
 */

import { fetchFromGithub, getDeployedSha } from './self-healing-diagnosis-service';

export type RepairRecommendedAction =
  /** Tiny diff that's clearly the regression — propose a revert first. */
  | 'recover_to_last_passing_sha'
  /** Medium diff or new code added — propose a compensating fix. */
  | 'compensate'
  /** Large diff or no last_passing_content — needs full investigation. */
  | 'investigate'
  /** No SHA / no file — nothing to recover from; LLM works from scratch. */
  | 'no_known_good';

export interface RepairContext {
  has_known_good: boolean;
  target_file: string | null;
  last_passing_sha: string | null;
  current_sha: string | null;

  last_passing_content: string | null;
  current_content: string | null;

  // Cheap diff stats for the spec_markdown summary (and the
  // recommendation heuristic). The LLM does the actual semantic diff.
  last_passing_line_count: number | null;
  current_line_count: number | null;
  delta_lines: number | null;

  recommended_action: RepairRecommendedAction;
  recommendation_rationale: string;

  fetch_errors: string[];
}

/**
 * Tiny, capped fetch — keeps the spec_markdown bounded.
 *
 * The full file content goes into `spec_snapshot.spec_markdown` which
 * eventually rides on an autopilot_recommendations row read by the
 * Cloud Run autopilot job. We cap at 16 KB per side to keep the
 * recommendation row size reasonable; large files get truncated with
 * a marker the LLM can read.
 */
const MAX_CONTENT_BYTES = 16 * 1024;

function truncate(content: string | null): string | null {
  if (!content) return content;
  if (content.length <= MAX_CONTENT_BYTES) return content;
  return content.slice(0, MAX_CONTENT_BYTES) +
    `\n\n... [truncated to ${MAX_CONTENT_BYTES} bytes; original was ${content.length} bytes]`;
}

function lineCount(content: string | null): number | null {
  if (content === null) return null;
  if (content === '') return 0;
  return content.split('\n').length;
}

/**
 * Decide which action to suggest to the repair LLM.
 *
 *   no SHA / no file     → no_known_good (work from scratch)
 *   no last_passing      → investigate (we know the SHA but couldn't fetch)
 *   delta ≤ 10 lines     → recover_to_last_passing_sha
 *   delta ≤ 60 lines     → compensate (small enough to reason about)
 *   otherwise            → investigate
 */
export function recommendAction(
  hasTargetFile: boolean,
  hasLastPassingSha: boolean,
  hasLastPassingContent: boolean,
  hasCurrentContent: boolean,
  deltaLines: number | null,
): { action: RepairRecommendedAction; rationale: string } {
  if (!hasTargetFile || !hasLastPassingSha) {
    return {
      action: 'no_known_good',
      rationale: hasTargetFile
        ? 'no last_passing_sha recorded yet — first failure cycle for this contract'
        : 'contract has no target_file — known-good recovery not applicable',
    };
  }
  if (!hasLastPassingContent) {
    return {
      action: 'investigate',
      rationale: 'last_passing_sha known but file content unfetchable (GitHub API miss)',
    };
  }
  if (!hasCurrentContent) {
    return {
      action: 'investigate',
      rationale: 'current file content unfetchable — diff cannot be computed',
    };
  }
  if (deltaLines === null) {
    return { action: 'investigate', rationale: 'delta could not be computed' };
  }
  const abs = Math.abs(deltaLines);
  if (abs <= 10) {
    return {
      action: 'recover_to_last_passing_sha',
      rationale: `tiny diff (${deltaLines} lines) — direct revert is the safe default; LLM may compensate if revert would lose intentional change`,
    };
  }
  if (abs <= 60) {
    return {
      action: 'compensate',
      rationale: `moderate diff (${deltaLines} lines) — too large to blindly revert; LLM should explain the regression then write a targeted fix`,
    };
  }
  return {
    action: 'investigate',
    rationale: `large diff (${deltaLines} lines) — major refactor since last_passing_sha; LLM may need additional context (callers, tests) before proposing a fix`,
  };
}

/**
 * Build the repair context for a contract failure. Pure-ish: depends on
 * GitHub Contents API + env (BUILD_INFO/DEPLOYED_GIT_SHA). Tests inject
 * mocks via process.env + jest.mock as needed.
 */
export async function buildRepairContext(args: {
  targetFile: string | null;
  lastPassingSha: string | null;
}): Promise<RepairContext> {
  const errors: string[] = [];
  const targetFile = args.targetFile;
  const lastPassingSha = args.lastPassingSha;
  const currentSha = getDeployedSha();

  if (!targetFile || !lastPassingSha) {
    const rec = recommendAction(Boolean(targetFile), Boolean(lastPassingSha), false, false, null);
    return {
      has_known_good: false,
      target_file: targetFile,
      last_passing_sha: lastPassingSha,
      current_sha: currentSha,
      last_passing_content: null,
      current_content: null,
      last_passing_line_count: null,
      current_line_count: null,
      delta_lines: null,
      recommended_action: rec.action,
      recommendation_rationale: rec.rationale,
      fetch_errors: errors,
    };
  }

  // Fetch in parallel — both call GitHub Contents API; one round-trip each.
  const [lastPassing, current] = await Promise.all([
    fetchFromGithub(targetFile, lastPassingSha),
    currentSha
      ? fetchFromGithub(targetFile, currentSha)
      : fetchFromGithub(targetFile, 'main'),
  ]);

  if (!lastPassing.ok) errors.push(`fetch_last_passing_failed:${lastPassingSha.slice(0, 7)}`);
  if (!current.ok) errors.push(`fetch_current_failed:${currentSha?.slice(0, 7) || 'main'}`);

  const lastPassingContent = lastPassing.ok && lastPassing.content !== undefined
    ? lastPassing.content
    : null;
  const currentContent = current.ok && current.content !== undefined
    ? current.content
    : null;

  const lpLines = lineCount(lastPassingContent);
  const curLines = lineCount(currentContent);
  const delta = lpLines !== null && curLines !== null ? curLines - lpLines : null;

  const rec = recommendAction(
    true,
    true,
    lastPassingContent !== null,
    currentContent !== null,
    delta,
  );

  return {
    has_known_good: lastPassingContent !== null,
    target_file: targetFile,
    last_passing_sha: lastPassingSha,
    current_sha: currentSha,
    last_passing_content: truncate(lastPassingContent),
    current_content: truncate(currentContent),
    last_passing_line_count: lpLines,
    current_line_count: curLines,
    delta_lines: delta,
    recommended_action: rec.action,
    recommendation_rationale: rec.rationale,
    fetch_errors: errors,
  };
}

/**
 * Render the repair context into a markdown section the LLM gets in
 * its spec_markdown. Designed to slot into the existing failure-scanner
 * spec template after the "## Repair contract" block.
 */
export function renderRepairContextMarkdown(ctx: RepairContext): string {
  if (!ctx.has_known_good) {
    return `## Known-good recovery context

_Not available._ ${ctx.recommendation_rationale}

Suggested action: \`${ctx.recommended_action}\`.
`;
  }
  return `## Known-good recovery context

The contract last passed at SHA \`${ctx.last_passing_sha}\` ${ctx.current_sha ? `against the current SHA \`${ctx.current_sha}\`` : ''}.

**Diff summary**: ${ctx.last_passing_line_count} → ${ctx.current_line_count} lines (delta ${ctx.delta_lines! >= 0 ? '+' : ''}${ctx.delta_lines}).

**Recommended action**: \`${ctx.recommended_action}\` — ${ctx.recommendation_rationale}.

### Last passing content (\`${ctx.target_file}\` @ \`${ctx.last_passing_sha?.slice(0, 7)}\`)

\`\`\`
${ctx.last_passing_content}
\`\`\`

### Current content (\`${ctx.target_file}\`${ctx.current_sha ? ` @ \`${ctx.current_sha.slice(0, 7)}\`` : ''})

\`\`\`
${ctx.current_content}
\`\`\`

**Repair guidance**:
- If \`recommended_action == 'recover_to_last_passing_sha'\`: revert is the safe default. Only deviate if the diff contains intentional behavior changes that should be preserved.
- If \`recommended_action == 'compensate'\`: explain in the PR description why the diff broke the contract, then write a targeted fix that keeps the intentional changes.
- If \`recommended_action == 'investigate'\`: the diff is too large to reason about in isolation. Read the failing test, read the immediate callers of \`${ctx.target_file}\`, and decide whether the regression is in this file or somewhere upstream.
`;
}
