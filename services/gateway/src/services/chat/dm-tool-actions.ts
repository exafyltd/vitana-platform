/**
 * VTID-03587 — surface a text-DM turn's tool calls to the client.
 *
 * THE BUG THIS CLOSES
 * -------------------
 * `handleVitanaTextReply()` (routes/chat.ts) wrote only `result.reply` into
 * `chat_messages` and never read `result.tool_calls`. `processConversationTurn`
 * builds that array, logs it to OASIS, and it was then dropped on the floor.
 *
 * The user-visible consequence, reported live: the assistant says "Hier sind
 * die neuesten Nachrichten aus der Longevity-Community:" — narration that
 * accompanies a navigation tool call — and nothing opens. The user says "dann
 * zeig mir doch", the identical turn runs, and it announces the same thing
 * again. Indefinitely. The model was not looping; the channel that would have
 * performed the action did not exist on this surface.
 *
 * WHY A NORMALISED SHAPE RATHER THAN THE RAW ARRAY
 * ------------------------------------------------
 * `tool_calls` carries whatever each handler returned, including internals a
 * chat client has no business seeing. This extracts only what a client needs to
 * act — a kind, a destination, a label — so the stored metadata is a deliberate
 * contract rather than an accidental dump of tool internals into a user-visible
 * row.
 *
 * The `request_identity_redirect` precedent (conversation-client.ts) already
 * does exactly this for identity edits: a tool call becomes a
 * `vitana:open-life-compass`-style CustomEvent the frontend listens for. This
 * generalises that one-off to navigation.
 *
 * FAIL-SOFT, ON PURPOSE — BUT NOT SILENT
 * --------------------------------------
 * A malformed tool call must never cost the user their reply text, so every
 * extraction is defensive and returns `[]` rather than throwing. It does NOT
 * swallow quietly: an unrecognised navigation-shaped call is logged, because
 * "the action silently did nothing" is the exact failure mode this file exists
 * to end (cf. VTID-03480 — a fail-soft path with no signal is undetectable).
 */

/** A client-actionable instruction derived from one tool call. */
export interface DmAction {
  /** `navigate` opens a screen; `redirect_event` dispatches a named CustomEvent. */
  kind: 'navigate' | 'redirect_event';
  /** Canonical screen id, when the tool resolved one. */
  screen_id?: string;
  /** Route the client should open. */
  route?: string;
  /** Human-readable destination name, safe to show. */
  title?: string;
  /** CustomEvent name, for `redirect_event`. */
  event?: string;
  /** Optional section/field hints carried by identity redirects. */
  section?: string;
  field?: string;
}

interface LooseToolCall {
  name?: unknown;
  args?: unknown;
  result?: unknown;
  success?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Tool names that mean "take the user somewhere". */
const NAVIGATION_TOOLS = new Set(['navigate', 'navigate_to_screen']);
const REDIRECT_TOOLS = new Set(['request_identity_redirect']);

/**
 * Extract the client-actionable instructions from a turn's tool calls.
 *
 * Returns `[]` when there is nothing to act on — which is the common case and
 * must stay cheap, since this runs on every Vitana DM reply.
 */
export function extractDmActions(toolCalls: unknown): DmAction[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

  const actions: DmAction[] = [];

  for (const raw of toolCalls as LooseToolCall[]) {
    const call = asRecord(raw);
    if (!call) continue;

    const name = str(call.name);
    if (!name) continue;

    // A tool that reported failure has nothing for the client to act on.
    if (call.success === false) continue;

    const args = asRecord(call.args) ?? {};
    const result = asRecord(call.result) ?? {};

    if (NAVIGATION_TOOLS.has(name)) {
      // The resolved destination can land on either side depending on which
      // handler ran, so read result first (authoritative — it is post-resolution
      // and post-fuzzy-match) and fall back to the raw args.
      const screen_id = str(result.screen_id) ?? str(args.screen_id);
      const route = str(result.route) ?? str(args.route);
      const title = str(result.title) ?? str(args.title);

      if (!screen_id && !route) {
        // Navigation was attempted but resolved nothing — that is the
        // "ambiguous"/"unknown" consult outcome. Correct to emit no action (the
        // assistant asks a clarifying question instead), but worth a line so it
        // is distinguishable from "no navigation was attempted at all".
        console.log(
          `[DM-ACTIONS] ${name} produced no destination — no client action emitted (unresolved consult)`,
        );
        continue;
      }
      actions.push({ kind: 'navigate', screen_id, route, title });
      continue;
    }

    if (REDIRECT_TOOLS.has(name)) {
      const event = str(args.event) ?? str(result.event);
      if (!event) {
        console.log(`[DM-ACTIONS] ${name} carried no event name — skipped`);
        continue;
      }
      actions.push({
        kind: 'redirect_event',
        event,
        section: str(args.section),
        field: str(args.field),
      });
    }
  }

  return actions;
}
