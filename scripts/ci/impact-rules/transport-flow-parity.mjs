/**
 * transport-flow-parity
 *
 * THE RULE (conversation-flow roadmap v3, Step 1a — docs/CONVERSATION_FLOW_ROADMAP_V3.md):
 * the conversation flow must be ONE transport-independent brain. Every transport
 * (`routes/orb-live.ts` = Vertex, `routes/orb-livekit.ts` = LiveKit, future
 * providers, text) is meant to be a THIN adapter — gather context → call the
 * brain (`services/conversation/`) → render — with ZERO independent
 * register / recency / `wake_opener` decision logic of its own.
 *
 * Today `routes/orb-live.ts` violates that: its `sendGreetingPromptToLiveAPI`
 * owns the whole greeting ladder inline (9 `wake_opener` branches + its own
 * recency/register handling + per-language directive maps). This scanner makes
 * that fragmentation VISIBLE on every PR that touches a transport file, and
 * counts the inline branches so progress is measurable as they are strangled.
 *
 * SEVERITY: `blocker` (flipped from `warning` at the END of Step 1c, VTID-03366).
 * Every Vertex opening rung — the sync ladder (silent_reconnect / override_v2 /
 * silenced_on_cadence / legacy default) and the async safe-fast ladder (rungs
 * 1–6) — now delegates to the brain (`computeGreetingDecision`), and
 * routes/orb-live.ts carries ZERO inline wake_opener branches. The rule now
 * ENFORCES "one brain, every surface": any PR that reintroduces inline register /
 * recency / wake_opener decision logic into a transport fails CI. (It was
 * `warning` throughout Steps 1a–1c so it reported fragmentation without blocking
 * the strangler-fig extraction mid-flight.)
 *
 * Scope: fires only when a PR actually adds/modifies a transport file (so it
 * surfaces local decision logic right where it is being edited — the #2814
 * collision class — without nagging unrelated PRs). A transport file that has
 * fully delegated (zero inline branches, zero inline directive maps) is clean.
 */

import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'transport-flow-parity',
  category: 'semantic',
  // Flipped warning → blocker at the END of Step 1c (VTID-03366): every Vertex
  // opening rung (sync + safe-fast) now delegates to the shared brain and
  // routes/orb-live.ts carries ZERO inline wake_opener branches. From here the
  // rule ENFORCES "one brain, every surface" — any PR that reintroduces inline
  // register / recency / wake_opener decision logic into a transport fails CI.
  severity: 'blocker',
};

// The transport integration files that MUST delegate the opening decision to the
// shared brain rather than owning it inline.
// VTID-04417 (Plan v1 WS-1.5): the session-start controller joins them — it is
// where the voice context is assembled for both WS and SSE.
export const TRANSPORT_FILES = [
  'services/gateway/src/routes/orb-live.ts',
  'services/gateway/src/routes/orb-livekit.ts',
  'services/gateway/src/orb/live/session/live-session-controller.ts',
];

// VTID-04417 (WS-1.5): a transport must decide the opening through the brain
// entry point (`decideOpeningFlow` → `decideConversationFlow`, VTID-04416),
// never by calling the ladder directly …
const DIRECT_DECISION_RE = /\bcomputeGreetingDecision\(/;
// … and must assemble the voice session context through the shared builder
// (`orb/live/session/session-context-builder.ts`, VTID-04414), never by calling
// a context builder directly. Passing the legacy builder as a dependency
// (`{ legacy: buildBootstrapContextPack }`) is not a call and is fine.
const DIRECT_CONTEXT_RE = /\b(buildBootstrapContextPack|buildBrainSystemInstruction|buildBrainSystemInstructionCached)\(/;
// A deliberate exception carries this marker on the line or one of the two
// lines above it, with a reason.
const ALLOW_MARKER = 'brain-parity-allow:';

/**
 * Pure scan of one transport source. Comment lines and the builder's own
 * definition are ignored. Exported for tests.
 */
export function scanTransportSource(src) {
  const lines = String(src || '').split('\n');
  const directDecisionLines = [];
  const directContextLines = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const allowed = [line, lines[i - 1] || '', lines[i - 2] || ''].some((l) => l.includes(ALLOW_MARKER));
    if (DIRECT_DECISION_RE.test(line) && !/function\s+computeGreetingDecision\(/.test(line) && !allowed) {
      directDecisionLines.push(i + 1);
    }
    if (DIRECT_CONTEXT_RE.test(line) && !/function\s+(buildBootstrapContextPack|buildBrainSystemInstruction\w*)\(/.test(line) && !allowed) {
      directContextLines.push(i + 1);
    }
  });
  const branchCount = (src.match(WAKE_OPENER_EMIT_RE) || []).length;
  const inlineSignals = INLINE_DIRECTIVE_SIGNALS.filter((s) =>
    new RegExp(`\\b${s.token}\\b`).test(src),
  ).map((s) => s.label);
  return { branchCount, inlineSignals, directDecisionLines, directContextLines };
}

// Each inline `wake_opener: '<kind>'` emit is a rung that decided + composed the
// opener locally instead of delegating. Counting them measures fragmentation.
const WAKE_OPENER_EMIT_RE = /wake_opener:\s*['"][a-z0-9_]+['"]/gi;

// Secondary signals: per-language directive maps / register orchestration that
// belong in the brain, not the transport.
const INLINE_DIRECTIVE_SIGNALS = [
  { token: 'greetingByLang', label: 'greetingByLang directive map' },
  { token: 'wakeTriggerByLang', label: 'wakeTriggerByLang directive map' },
  { token: 'greetingPrompts', label: 'greetingPrompts directive map' },
  { token: 'anonPrompts', label: 'anonPrompts directive map' },
];

export async function check({ changedFiles, repoRoot }) {
  const touched = new Set(
    changedFiles.filter((f) => f.status === 'A' || f.status === 'M').map((f) => f.path),
  );

  const findings = [];
  for (const file of TRANSPORT_FILES) {
    if (!touched.has(file)) continue; // only flag transports this PR is editing
    const src = readFileAtRepo(repoRoot, file);
    if (!src) continue;

    const { branchCount, inlineSignals, directDecisionLines, directContextLines } = scanTransportSource(src);

    if (directDecisionLines.length > 0) {
      findings.push({
        rule: meta.rule,
        severity: meta.severity,
        file_path: file,
        line_number: directDecisionLines[0],
        message:
          `Transport \`${file}\` calls \`computeGreetingDecision\` directly ` +
          `(line ${directDecisionLines.join(', ')}). Every opening decision goes through the ` +
          `brain entry point.`,
        suggested_action:
          `Call \`decideOpeningFlow(ctx, { transport, role })\` from ` +
          `services/conversation/decide-conversation-flow.ts (VTID-04416). It returns the same ` +
          `GreetingDecision, through decideConversationFlow.`,
        raw: { direct_decision_lines: directDecisionLines },
      });
    }

    if (directContextLines.length > 0) {
      findings.push({
        rule: meta.rule,
        severity: meta.severity,
        file_path: file,
        line_number: directContextLines[0],
        message:
          `Transport \`${file}\` assembles the voice context by calling a context builder ` +
          `directly (line ${directContextLines.join(', ')}) instead of the shared session-context builder.`,
        suggested_action:
          `Use \`buildBaseSessionContext\` / \`rebuildSessionContext\` / \`buildLessonContext\` from ` +
          `orb/live/session/session-context-builder.ts (VTID-04414), passing the legacy builder as ` +
          `\`{ legacy: buildBootstrapContextPack }\`. A deliberate exception (a debug route, a cache ` +
          `warm) carries \`// ${ALLOW_MARKER} <reason>\` on or just above the line.`,
        raw: { direct_context_lines: directContextLines },
      });
    }

    // Fully delegated → no inline opening decision left → clean.
    if (branchCount === 0 && inlineSignals.length === 0) continue;

    const parts = [];
    if (branchCount > 0) parts.push(`${branchCount} inline \`wake_opener\` branch(es)`);
    if (inlineSignals.length > 0) parts.push(inlineSignals.join(', '));

    findings.push({
      rule: meta.rule,
      severity: meta.severity,
      file_path: file,
      line_number: null,
      message:
        `Transport \`${file}\` still contains its own conversation-flow decision logic ` +
        `(${parts.join('; ')}) instead of delegating to the shared brain in ` +
        `services/gateway/src/services/conversation/. One brain, every surface: the ` +
        `transport should gather context, call the brain, and render.`,
      suggested_action:
        `Route the opening decision through the shared brain ` +
        `(\`decideOpeningFlow\` → \`decideConversationFlow\`) and delete the inline branch(es).`,
      raw: { wake_opener_branches: branchCount, inline_directive_signals: inlineSignals },
    });
  }

  return findings;
}
