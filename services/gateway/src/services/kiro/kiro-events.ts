/**
 * VTID-04975: live events for one Kiro turn.
 *
 * A separate type from OperatorTurnEvent (gemini-operator.ts) on purpose: the
 * existing union is consumed by the console and stays untouched. The SSE
 * route writes `type` as the frame name, so these flow through unchanged.
 *
 * Mapped from ACP session notifications. kiro-cli's docs name them
 * AgentMessageChunk / ToolCall / ToolCallUpdate / TurnEnd; the open ACP spec
 * names the same updates agent_message_chunk / tool_call / tool_call_update.
 * Both spellings are accepted.
 */

export const KIRO_EVENT_TEXT_MAX_CHARS = 4000;
export const KIRO_EVENT_ARGS_MAX_CHARS = 1200;

export type KiroTurnEvent =
  | { type: 'kiro.message_chunk'; text: string }
  | { type: 'kiro.tool_call'; tool_call_id: string; title: string; kind: string; status: string }
  | { type: 'kiro.tool_update'; tool_call_id: string; status: string; title?: string }
  | { type: 'kiro.permission_request'; request_id: string; tool_call_id: string | null; title: string; kind: string; expires_at: string }
  | { type: 'kiro.turn_end'; stop_reason: string };

export type KiroTurnEventSink = (event: KiroTurnEvent) => void;

export function clipKiroText(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : value == null ? '' : safeJson(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function normKind(raw: unknown): string {
  return typeof raw === 'string' && raw ? raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : '';
}

/**
 * Map the params of one ACP session notification to a Kiro event, or null for
 * updates the console does not show (plans, mode changes, usage…).
 */
export function mapAcpUpdate(params: unknown): KiroTurnEvent | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const u = (p.update ?? p) as Record<string, unknown>;
  const kind = normKind(u.sessionUpdate ?? u.session_update ?? u.type);
  if (kind === 'agent_message_chunk') {
    const content = (u.content ?? {}) as Record<string, unknown>;
    const text = typeof content.text === 'string' ? content.text : typeof u.text === 'string' ? (u.text as string) : '';
    return text ? { type: 'kiro.message_chunk', text: clipKiroText(text, KIRO_EVENT_TEXT_MAX_CHARS) } : null;
  }
  if (kind === 'tool_call') {
    return {
      type: 'kiro.tool_call',
      tool_call_id: String(u.toolCallId ?? u.tool_call_id ?? ''),
      title: clipKiroText(u.title ?? u.name ?? '', KIRO_EVENT_ARGS_MAX_CHARS),
      kind: normKind(u.kind) || 'other',
      status: String(u.status ?? 'pending'),
    };
  }
  if (kind === 'tool_call_update') {
    const title = u.title == null ? undefined : clipKiroText(u.title, KIRO_EVENT_ARGS_MAX_CHARS);
    return {
      type: 'kiro.tool_update',
      tool_call_id: String(u.toolCallId ?? u.tool_call_id ?? ''),
      status: String(u.status ?? ''),
      ...(title ? { title } : {}),
    };
  }
  if (kind === 'turn_end') {
    return { type: 'kiro.turn_end', stop_reason: String(u.stopReason ?? u.stop_reason ?? 'end_turn') };
  }
  return null;
}
