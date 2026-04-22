/**
 * Delimiter-format parser — mirror of the one in
 * services/gateway/src/services/dev-autopilot-execute.ts.
 *
 * Duplicated (rather than shared via a package) because this repo isn't a
 * monorepo with cross-service publishing set up. The two copies MUST stay
 * behaviourally identical — both ends of the queue speak the same dialect.
 * If you change one, change the other, and add a test to both sides.
 *
 * The gateway already has a passing test suite locking this parser's
 * behaviour against the kind of output Claude emits (code with quotes,
 * backslashes, braces, template literals). See
 * services/gateway/test/dev-autopilot-execute.test.ts.
 */

export interface ExecutionFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content?: string;
}

export interface ExecutionOutput {
  files: ExecutionFile[];
  pr_title: string;
  pr_body: string;
}

export function parseExecutionOutput(raw: string): ExecutionOutput | { error: string } {
  const text = raw.trim();

  const titleMatch = text.match(/<<<PR_TITLE>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!titleMatch) return { error: 'Missing <<<PR_TITLE>>>…<<<END>>> block' };
  const pr_title = titleMatch[1].trim();

  const bodyMatch = text.match(/<<<PR_BODY>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!bodyMatch) return { error: 'Missing <<<PR_BODY>>>…<<<END>>> block' };
  const pr_body = bodyMatch[1];

  const fileRe = /<<<FILE\s+(create|modify|delete)\s+([^\s>]+)\s*>>>\s*\r?\n([\s\S]*?)\r?\n<<<END>>>/g;
  const files: ExecutionFile[] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    const action = m[1] as 'create' | 'modify' | 'delete';
    const path = m[2].trim();
    const content = action === 'delete' ? undefined : m[3];
    files.push({ path, action, content });
  }
  if (files.length === 0) {
    return { error: 'No <<<FILE …>>>…<<<END>>> blocks found' };
  }

  return { files, pr_title, pr_body };
}
