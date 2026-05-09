#!/usr/bin/env node
/**
 * Orb-tools lift-not-duplicate parity scanner.
 *
 * Walks two files and reports drift between them:
 *   - services/gateway/src/services/orb-tools-shared.ts (ORB_TOOL_REGISTRY)
 *     — the canonical implementation list both pipelines route through.
 *   - services/gateway/src/routes/orb-live.ts (Vertex pipeline)
 *     — the WebSocket handler that should DELEGATE to dispatchOrbToolForVertex
 *     for every tool in the registry.
 *
 * Reports four kinds of drift. Two modes:
 *
 *   REPORT-ONLY (default, when no env var):
 *     Always exits 0. Prints the report to stdout. CI posts the report
 *     as a PR comment but doesn't fail the build. Lets work continue
 *     while the team progressively lifts remaining tools.
 *
 *   GATE (set ORB_TOOLS_PARITY_GATE=1):
 *     Exits 2 on DRIFT-CRITICAL (Vertex case for a tool in the shared
 *     registry whose body does NOT call dispatchOrbToolForVertex), 1 on
 *     warning-only drift, 0 on clean. Promote to gate mode once all
 *     intentional drift has been lifted or marked exempt.
 *
 * Designed to be cheap (regex only, no TS parse) so it runs on every PR
 * touching either file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SHARED = resolve(ROOT, 'services/gateway/src/services/orb-tools-shared.ts');
const VERTEX = resolve(ROOT, 'services/gateway/src/routes/orb-live.ts');

function readSource(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[parity] failed to read ${path}: ${err.message}`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Step 1: extract registry keys from orb-tools-shared.ts
// ---------------------------------------------------------------------------

function extractRegistry(src) {
  // Find the `ORB_TOOL_REGISTRY` block and pull each `tool_name:` key.
  const idx = src.indexOf('ORB_TOOL_REGISTRY');
  if (idx < 0) {
    console.error('[parity] could not find ORB_TOOL_REGISTRY in shared module');
    process.exit(3);
  }
  // Find the matching closing brace of the object literal.
  const open = src.indexOf('{', idx);
  if (open < 0) {
    console.error('[parity] ORB_TOOL_REGISTRY: no opening brace');
    process.exit(3);
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    console.error('[parity] ORB_TOOL_REGISTRY: no closing brace');
    process.exit(3);
  }
  const body = src.slice(open + 1, close);
  const keys = new Set();
  // Match keys like `  search_events: tool_search_events,` or `  search_web: (args) => ...`
  for (const m of body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Step 2: extract Vertex tool cases + check delegation
// ---------------------------------------------------------------------------

/**
 * Returns Map<toolName, { delegated: boolean, lineNumber: number }>.
 * `delegated` = true when the case body contains `dispatchOrbToolForVertex`.
 */
function extractVertexCases(src) {
  const cases = new Map();
  const lines = src.split('\n');

  // Identify the switch-statement region. Vertex's main tool dispatch sits
  // inside `switch (toolName)`. Some non-tool cases are protocol messages
  // (audio, audio_ready, end_turn, ping, reconnect, start, stop, text,
  // video, first, long, recent, week, today, yesterday, same_day, interrupt)
  // which we skip via a deny-list.
  const PROTOCOL = new Set([
    'audio', 'audio_ready', 'end_turn', 'ping', 'reconnect',
    'start', 'stop', 'text', 'video',
    'first', 'long', 'recent', 'week', 'today', 'yesterday',
    'same_day', 'interrupt',
    // generic switch arms in unrelated helpers within the file
  ]);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^\s*case '([a-z_][a-z0-9_]*)':\s*\{?/);
    if (!m) {
      i++;
      continue;
    }
    // Collect all consecutive fall-through case labels (case 'a': case 'b':
    // { body }). The body belongs to ALL of them, so each name shares the
    // same delegated status.
    const fallThroughNames = [];
    const fallThroughLines = [];
    let cursor = i;
    while (cursor < lines.length) {
      const cur = lines[cursor];
      const cm = cur.match(/^\s*case '([a-z_][a-z0-9_]*)':\s*\{?\s*$/);
      if (!cm) break;
      fallThroughNames.push(cm[1]);
      fallThroughLines.push(cursor + 1);
      // If this case line has the opening brace, the body starts here.
      if (/\{\s*$/.test(cur)) {
        break;
      }
      cursor++;
    }
    // The line we just stopped on is the case-with-body (or we ran out of
    // case lines). Walk forward to find the closing brace of the body.
    let depth = 0;
    let openSeen = false;
    let body = '';
    let j = cursor;
    for (; j < lines.length; j++) {
      const lj = lines[j];
      for (const ch of lj) {
        if (ch === '{') {
          depth++;
          openSeen = true;
        } else if (ch === '}') depth--;
      }
      body += lj + '\n';
      if (openSeen && depth === 0) break;
    }
    // Either dispatchOrbToolForVertex (the {success,result,error} adapter)
    // OR dispatchOrbTool (when Vertex needs the structured OrbToolResult,
    // e.g. play_music reads result.directive to emit via SSE/WS) counts as
    // delegation.
    const delegated = /dispatchOrbTool(ForVertex)?\b/.test(body);
    for (let k = 0; k < fallThroughNames.length; k++) {
      const n = fallThroughNames[k];
      if (PROTOCOL.has(n)) continue;
      if (!cases.has(n)) {
        cases.set(n, { delegated, lineNumber: fallThroughLines[k] });
      }
    }
    i = j + 1;
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Step 3: diff + report
// ---------------------------------------------------------------------------

const sharedSrc = readSource(SHARED);
const vertexSrc = readSource(VERTEX);

const registry = extractRegistry(sharedSrc);
const vertexCases = extractVertexCases(vertexSrc);

// In-shared but no Vertex case → tool is exposed to LiveKit only.
const sharedOnly = [];
// Vertex case exists for a tool in the shared registry, but the case body
// does NOT call dispatchOrbToolForVertex → DRIFT (unless allowlisted).
const inlineDrift = [];
// Allowlisted intentional inline — Vertex's impl is genuinely WebSocket-
// session-state-coupled and lifting would break Vertex behaviour. The
// shared module keeps a placeholder so LiveKit's tools.py wrapper can
// still call /api/v1/orb/tool without a 404.
const VERTEX_ONLY_INTENTIONAL = new Set([
  'switch_persona',       // mutates session.pendingPersonaSwap, persona-overrides, etc.
  'report_to_specialist', // tied to Vertex's WebSocket persona-swap orchestration
]);
// Tools in ORB_TOOL_REGISTRY that don't have a `case` arm in the switch
// because Vertex routes them via a DEDICATED handler before the switch
// (handleNavigate, handleNavigateToScreen, handleGetCurrentScreen — all
// PR 1.B-3..5 lifts that delegate via dispatchOrbTool internally). Without
// this allowlist the scanner flags them as `shared-only` warnings, which
// in gate mode causes a false-positive build failure.
const SHARED_ONLY_INTENTIONAL = new Set([
  'navigate',             // Vertex: handleNavigate at orb-live.ts (PR 1.B-4)
  'navigate_to_screen',   // Vertex: handleNavigateToScreen (PR 1.B-5)
  'get_current_screen',   // Vertex: handleGetCurrentScreen (PR 1.B-3)
]);
const intentionalInline = [];

// Tracked separately so the report shows "shared-only OK" for the
// dedicated-handler set without contributing to the warning exit code.
const sharedOnlyOk = [];
for (const name of registry) {
  const v = vertexCases.get(name);
  if (!v) {
    if (SHARED_ONLY_INTENTIONAL.has(name)) sharedOnlyOk.push(name);
    else sharedOnly.push(name);
    continue;
  }
  if (!v.delegated) {
    if (VERTEX_ONLY_INTENTIONAL.has(name)) {
      intentionalInline.push({ name, lineNumber: v.lineNumber });
    } else {
      inlineDrift.push({ name, lineNumber: v.lineNumber });
    }
  }
}

// Vertex cases for tools NOT in the shared registry → LiveKit doesn't route them
// (e.g. switch_persona, search_memory, consult_external_ai). These are
// intentional skips per PR B-N decisions.
const vertexOnly = [];
for (const [name, v] of vertexCases) {
  if (!registry.has(name)) {
    vertexOnly.push({ name, lineNumber: v.lineNumber, delegated: v.delegated });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let out = '';
out += '## orb-tools lift-not-duplicate parity report\n\n';
out += `Shared registry: **${registry.size} tools** in ORB_TOOL_REGISTRY.\n`;
out += `Vertex cases (excluding protocol arms): **${vertexCases.size}**.\n\n`;

let exitCode = 0;

if (inlineDrift.length > 0) {
  out += `### 🔴 DRIFT-CRITICAL — ${inlineDrift.length} Vertex case(s) NOT delegating\n\n`;
  out += 'These tools are in `ORB_TOOL_REGISTRY` but Vertex still has inline logic. ';
  out += 'Replace the case body with `dispatchOrbToolForVertex(...)` in `orb-live.ts`.\n\n';
  for (const d of inlineDrift) {
    out += `- \`${d.name}\` — orb-live.ts:${d.lineNumber}\n`;
  }
  out += '\n';
  exitCode = 2;
}

if (intentionalInline.length > 0) {
  out += `### ℹ️ intentional inline — ${intentionalInline.length} tool(s) allowlisted as Vertex-only\n\n`;
  out += 'These are in `ORB_TOOL_REGISTRY` (so LiveKit\'s tools.py wrapper doesn\'t 404) ';
  out += 'but their Vertex impl is intentionally NOT lifted because it\'s WebSocket-session-state-coupled. ';
  out += 'The allowlist is `VERTEX_ONLY_INTENTIONAL` in `scripts/orb-tools-lift-scanner.mjs`.\n\n';
  for (const v of intentionalInline) {
    out += `- \`${v.name}\` — orb-live.ts:${v.lineNumber}\n`;
  }
  out += '\n';
}

if (sharedOnly.length > 0) {
  out += `### ⚠️ shared-only — ${sharedOnly.length} tool(s) in registry without a Vertex case\n\n`;
  out += 'These exist in the shared dispatcher but Vertex never routes them ';
  out += '(LiveKit-only, or Vertex uses a separate handler outside the switch). Usually fine.\n\n';
  for (const n of sharedOnly) {
    out += `- \`${n}\`\n`;
  }
  out += '\n';
  if (exitCode === 0) exitCode = 1;
}

if (sharedOnlyOk.length > 0) {
  out += `### ℹ️ shared-only OK — ${sharedOnlyOk.length} tool(s) routed via dedicated Vertex handler\n\n`;
  out += 'These are in `ORB_TOOL_REGISTRY` but DON\'T appear as a `case` arm in ';
  out += 'the switch because Vertex routes them via a dedicated handler ';
  out += '(handleNavigate / handleNavigateToScreen / handleGetCurrentScreen) ';
  out += 'before the switch. Each handler delegates to the shared dispatcher ';
  out += 'internally — full parity, just not via a case arm. ';
  out += 'Allowlist: `SHARED_ONLY_INTENTIONAL` in `scripts/orb-tools-lift-scanner.mjs`.\n\n';
  for (const n of sharedOnlyOk) {
    out += `- \`${n}\`\n`;
  }
  out += '\n';
}

if (vertexOnly.length > 0) {
  const inline = vertexOnly.filter((v) => !v.delegated);
  const delegated = vertexOnly.filter((v) => v.delegated);
  if (inline.length > 0) {
    out += `### ℹ️ vertex-only inline — ${inline.length} tool(s) intentionally not lifted\n\n`;
    out += 'These have inline Vertex impls but are not in the shared registry. ';
    out += 'Likely Vertex-specific (SSE/WS directives, session state, retrieval-router context).\n\n';
    for (const v of inline) {
      out += `- \`${v.name}\` — orb-live.ts:${v.lineNumber}\n`;
    }
    out += '\n';
  }
  if (delegated.length > 0) {
    // Should never happen — a Vertex case calling dispatchOrbToolForVertex
    // for a tool NOT in the registry would 404. Flag.
    out += `### 🔴 BROKEN-DELEGATION — ${delegated.length} Vertex case(s) call shared for unknown tool\n\n`;
    for (const v of delegated) {
      out += `- \`${v.name}\` — orb-live.ts:${v.lineNumber} delegates but registry has no entry\n`;
    }
    out += '\n';
    exitCode = 2;
  }
}

if (exitCode === 0) {
  out += '### ✅ no drift detected\n\n';
  out += `Every tool in ORB_TOOL_REGISTRY that has a Vertex case is delegating to dispatchOrbToolForVertex.\n`;
}

process.stdout.write(out);

// Honour the gate env var. Default behaviour is report-only (exit 0)
// so the scanner doesn't block PRs while the team progressively lifts
// remaining tools. Once all intentional drift is handled, set
// ORB_TOOLS_PARITY_GATE=1 in the workflow and the scanner becomes a
// hard merge gate.
if (process.env.ORB_TOOLS_PARITY_GATE === '1') {
  process.exit(exitCode);
}
process.exit(0);
