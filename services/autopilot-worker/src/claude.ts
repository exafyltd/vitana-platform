/**
 * Wrapper around `claude -p <prompt> --output-format stream-json` — Claude
 * Code's headless mode.
 *
 * Why subprocess + stream-json instead of linking the Claude Agent SDK
 * directly? Because the subprocess inherits the Claude Code CLI's
 * authentication, which is what carries the Claude Pro/Max subscription
 * entitlement. The Agent SDK's npm package, when run standalone, still
 * wants an ANTHROPIC_API_KEY — which is exactly what we're trying to stop
 * using. The CLI invocation is the only documented path for subscription-
 * backed Claude usage from a script today.
 *
 * stream-json output looks like a sequence of NDJSON events ending with one
 * of type=result. We accumulate text from assistant turns, then read the
 * final result event for token usage + stop reason. On any non-zero exit
 * code, we return the captured stderr as the error.
 */

import { spawn } from 'child_process';

export interface RunClaudeOptions {
  /** Absolute or PATH-resolvable path to the claude CLI. Default: `claude`. */
  bin?: string;
  /** Model to invoke. Passed to the CLI as `--model`. Optional; when absent,
   * Claude Code picks the default model for the user's subscription tier. */
  model?: string;
  /** Timeout in ms after which the child is killed and we return an error. */
  timeoutMs?: number;
  /** Working directory for the claude process. Defaults to process.cwd(). */
  cwd?: string;
}

export interface RunClaudeResult {
  ok: boolean;
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  duration_ms?: number;
  error?: string;
}

/** Strip the ANSI escape sequences Claude Code sometimes emits to stderr for tty progress. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

export async function runClaude(prompt: string, opts: RunClaudeOptions = {}): Promise<RunClaudeResult> {
  const bin = opts.bin || process.env.CLAUDE_CLI_PATH || 'claude';
  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  const timeoutMs = opts.timeoutMs ?? 600_000; // 10 min default
  const startedAt = Date.now();

  return new Promise<RunClaudeResult>((resolve) => {
    let settled = false;
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd || process.cwd(),
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    const kill = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({
        ok: false,
        error: `claude subprocess timed out after ${Math.round(timeoutMs / 1000)}s`,
        duration_ms: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolve({
        ok: false,
        error: `failed to spawn '${bin}': ${String(err)}. Is Claude Code installed and on PATH?`,
        duration_ms: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = stripAnsi(Buffer.concat(stderrChunks).toString('utf-8')).slice(-2000);
      const duration = Date.now() - startedAt;

      if (code !== 0) {
        resolve({
          ok: false,
          error: `claude exit=${code}. stderr: ${stderr || '(empty)'}`,
          duration_ms: duration,
        });
        return;
      }

      // Parse stream-json: one JSON object per line.
      const lines = stdout.split('\n').filter(l => l.trim().length > 0);
      const textParts: string[] = [];
      let usage: RunClaudeResult['usage'] = undefined;
      let stopReason: string | undefined = undefined;

      for (const line of lines) {
        let event: unknown;
        try { event = JSON.parse(line); }
        catch { continue; }
        if (typeof event !== 'object' || event === null) continue;
        const e = event as Record<string, unknown>;

        // Assistant message turn — content is an array of blocks.
        if (e.type === 'assistant' && e.message && typeof e.message === 'object') {
          const msg = e.message as Record<string, unknown>;
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block && (block as Record<string, unknown>).type === 'text') {
                const t = (block as Record<string, unknown>).text;
                if (typeof t === 'string') textParts.push(t);
              }
            }
          }
          // Some runs emit usage directly on the message.
          if (msg.usage && typeof msg.usage === 'object') {
            const u = msg.usage as Record<string, unknown>;
            usage = {
              input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
              output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            };
          }
        }

        // Final result event at end of stream.
        if (e.type === 'result') {
          if (typeof e.stop_reason === 'string') stopReason = e.stop_reason;
          if (e.usage && typeof e.usage === 'object') {
            const u = e.usage as Record<string, unknown>;
            usage = {
              input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
              output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            };
          }
          // Older CLI versions put the final text on the result event.
          if (typeof e.result === 'string' && textParts.length === 0) {
            textParts.push(e.result);
          }
        }
      }

      const text = textParts.join('').trim();
      if (!text) {
        resolve({
          ok: false,
          error: `claude produced no text output. stderr tail: ${stderr || '(empty)'} stdout lines: ${lines.length}`,
          duration_ms: duration,
        });
        return;
      }

      resolve({
        ok: true,
        text,
        usage,
        stop_reason: stopReason,
        duration_ms: duration,
      });
    });

    // Send the prompt on stdin and close — this matches Claude Code's -p
    // contract for reading piped input.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(kill);
        resolve({
          ok: false,
          error: `failed to write prompt to claude stdin: ${String(err)}`,
          duration_ms: Date.now() - startedAt,
        });
      }
    }
  });
}
