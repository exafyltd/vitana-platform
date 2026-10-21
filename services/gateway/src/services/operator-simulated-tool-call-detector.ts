/**
 * Detects a real Operator Console failure mode observed live 2026-09-20
 * (VTID-04172): DeepSeek Flash, mid-generation, reasoned aloud about
 * whether it actually has real tool-calling capability ("I don't have a
 * real tool execution here... there's no function-calling harness shown
 * here"), talked itself out of invoking the tool, and instead emitted a
 * fenced ```json block shaped exactly like the tool's real arguments —
 * which read, to a human, as if the call had been made. No
 * `autopilot_run_task` (or `autopilot_execute_task`) tool result existed
 * on that turn at all; the whole thing was narrated, not executed.
 *
 * `gemini-operator.ts` never forces tool_choice (no `forceTool` is ever
 * passed for a chat turn — grep confirms), so nothing stops the model
 * from choosing to describe a call instead of making one. This module is
 * the detection half of the fix: a caller (operator.ts's
 * `runOperatorChatTurn`) uses it to notice the failure and retry once
 * with a stronger instruction, rather than silently returning the
 * hallucinated call as if it were real.
 */

/** Tool name -> the argument keys that, together, are distinctive enough
 * that a fenced JSON block containing all of them is almost certainly a
 * narrated call to that tool, not coincidental JSON about something else. */
const TOOL_CALL_ARG_SHAPES: Record<string, string[]> = {
  autopilot_run_task: ['title', 'request'],
  autopilot_execute_task: ['vtid', 'files_referenced'],
};

export interface SimulatedToolCallDetection {
  detected: boolean;
  toolName?: string;
  reason?: string;
}

/**
 * @param reply The model's final reply text for the turn.
 * @param executedToolNames Names of tools that ACTUALLY ran this turn
 *   (from `geminiResult.toolResults`), regardless of how many — a
 *   simulated call can appear alongside real, unrelated tool calls (the
 *   real 2026-09-20 case called `dev_read_file` for real, then
 *   *narrated* `autopilot_run_task` instead of calling it).
 */
export function detectSimulatedToolCallReply(
  reply: string,
  executedToolNames: string[],
): SimulatedToolCallDetection {
  if (!reply) return { detected: false };

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(reply)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const keys = Object.keys(parsed as Record<string, unknown>);

    for (const [toolName, requiredKeys] of Object.entries(TOOL_CALL_ARG_SHAPES)) {
      if (executedToolNames.includes(toolName)) continue; // a real call for THIS tool did happen — not simulated
      if (requiredKeys.every((k) => keys.includes(k))) {
        return {
          detected: true,
          toolName,
          reason: `reply contains a fenced JSON block shaped like ${toolName}'s real arguments (${requiredKeys.join(', ')}), but no real ${toolName} tool call was executed this turn`,
        };
      }
    }
  }

  return { detected: false };
}
