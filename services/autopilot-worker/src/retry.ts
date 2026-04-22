/**
 * Build a follow-up prompt for Claude when the first attempt at an execute
 * task produced code that `tsc --noEmit` rejects. We keep the original task
 * prompt in full (Claude needs the plan + file contents to rebuild from),
 * append what it emitted last time, the exact tsc errors from its own code,
 * and a short instruction to try again. Same delimiter output format.
 *
 * Keeping "your last attempt" in the prompt rather than just "the errors"
 * is deliberate — Claude is more reliable at patching its own draft than
 * at guessing what draft produced a given error. We truncate it to avoid
 * blowing the context window on a large file.
 */

const MAX_PRIOR_OUTPUT_CHARS = 40_000;
const MAX_ERROR_CHARS = 8_000;

export function buildRetryPrompt(
  originalPrompt: string,
  priorOutput: string,
  tscErrors: string[],
  attemptNumber: number,
): string {
  const errorsJoined = tscErrors.join('\n').slice(0, MAX_ERROR_CHARS);
  const priorTrimmed = priorOutput.length > MAX_PRIOR_OUTPUT_CHARS
    ? priorOutput.slice(0, MAX_PRIOR_OUTPUT_CHARS) + `\n... [truncated ${priorOutput.length - MAX_PRIOR_OUTPUT_CHARS} chars]`
    : priorOutput;

  return [
    originalPrompt,
    '',
    '---',
    '',
    `# Retry (attempt ${attemptNumber + 1})`,
    '',
    `Your previous output failed pre-PR TypeScript validation (\`tsc --noEmit\`).`,
    'Please emit a CORRECTED version of the entire output (same delimiter',
    'format — <<<PR_TITLE>>>, <<<PR_BODY>>>, one <<<FILE …>>> block per',
    'file). Fix the errors below. Do not apologise, do not explain the',
    'diff — just emit the corrected blocks.',
    '',
    '## Errors from your last attempt',
    '',
    '```',
    errorsJoined || '(no text captured — tsc probably timed out or crashed)',
    '```',
    '',
    '## Your previous output (for reference)',
    '',
    '```',
    priorTrimmed,
    '```',
    '',
    'Produce the corrected delimiter output now.',
  ].join('\n');
}
