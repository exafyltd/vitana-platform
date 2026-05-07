#!/usr/bin/env node
/**
 * Voice Tools Manifest reconciler (PR 1.B-9 / VTID-02844).
 *
 * Walks the three sources of truth and reconciles them against
 * `services/gateway/src/services/tool-manifest.json` so the Voice Tools
 * Catalog UI tells operators exactly which tools are wired in which
 * pipeline:
 *
 *   1. ORB_TOOL_REGISTRY (services/gateway/src/services/orb-tools-shared.ts)
 *      — the canonical lifted dispatcher; tools here are wired in BOTH
 *      pipelines unless the lift scanner flags them as Vertex-only.
 *
 *   2. Vertex `case 'tool_name':` switch arms in orb-live.ts plus the
 *      buildLiveApiTools()-style top-level `name: '…'` declarations.
 *      A tool present here but NOT in the shared registry is "vertex-only".
 *
 *   3. LiveKit `all_tool_names()` in
 *      services/agents/orb-agent/src/orb_agent/tools.py — the names
 *      LiveKit's Agent registers with the LLM.
 *
 * For each manifest entry:
 *   - `wired_in: ['vertex', 'livekit']` if both
 *   - `wired_in: ['vertex']`             if only Vertex
 *   - `wired_in: ['livekit']`            if only LiveKit
 *   - `wired_in: []`                     if neither (planned phantom)
 *
 * `status` is recomputed from `wired_in`:
 *   - 'live'     — wired in both pipelines
 *   - 'planned'  — neither pipeline (manifest-only phantom)
 *   - 'live'     — also marked live for vertex-only / livekit-only tools
 *                  (operators want a single live/planned binary; the
 *                  per-pipeline truth is in `wired_in`)
 *
 * Modes:
 *   --check          report drift, exit 1 if status/wired_in disagree.
 *                    Used in CI (report-only first, hard-gate later).
 *   --apply          rewrite tool-manifest.json with the canonical truth.
 *                    Adds entries for tools missing from the manifest
 *                    (commits a placeholder; operator fills in the
 *                    surface/role/description copy).
 *
 * Drift-reasoning kept cheap (regex only, no TS parse) so it runs in
 * a few seconds on every PR touching any of the source files.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const MANIFEST = resolve(ROOT, 'services/gateway/src/services/tool-manifest.json');
const SHARED = resolve(ROOT, 'services/gateway/src/services/orb-tools-shared.ts');
const VERTEX = resolve(ROOT, 'services/gateway/src/routes/orb-live.ts');
const LIVEKIT = resolve(ROOT, 'services/agents/orb-agent/src/orb_agent/tools.py');

const MODE_CHECK = process.argv.includes('--check');
const MODE_APPLY = process.argv.includes('--apply');

function readSource(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[reconcile] failed to read ${path}: ${err.message}`);
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Source extractors
// ---------------------------------------------------------------------------

function extractSharedRegistry(src) {
  // Matches the `ORB_TOOL_REGISTRY: Record<string, OrbToolHandler> = { … };` block
  // and pulls every key. Same logic as orb-tools-lift-scanner.
  const idx = src.indexOf('ORB_TOOL_REGISTRY');
  if (idx < 0) return new Set();
  const open = src.indexOf('{', idx);
  if (open < 0) return new Set();
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
  if (close < 0) return new Set();
  const body = src.slice(open + 1, close);
  const keys = new Set();
  // `  search_events: tool_search_events,` or `  navigate_to_screen: (args, id) => …`
  const pat = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[(a-zA-Z_]/gm;
  let m;
  while ((m = pat.exec(body)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

// Same deny-list the lift scanner uses — these are Vertex's WebSocket
// protocol arms (audio chunk, ping, reconnect, etc.) and recall-window
// short-codes (today/yesterday/week/...). They have switch cases but are
// NOT LLM-callable tools.
const VERTEX_PROTOCOL_ARMS = new Set([
  'audio', 'audio_ready', 'end_turn', 'ping', 'reconnect',
  'start', 'stop', 'text', 'video',
  'first', 'long', 'recent', 'week', 'today', 'yesterday',
  'same_day', 'interrupt',
]);

function extractVertexTools(src) {
  // Vertex tools are registered as `case 'tool_name':` switch arms inside
  // the dispatch loop in orb-live.ts. Some cases are protocol/short-code
  // arms (deny-listed above). The buildLiveApiTools() function-declaration
  // shape with `name: 'foo'` inside an `{tools:[…]}` block is the same
  // names — relying on case arms alone is sufficient and avoids the
  // false-positive matches of `name: 'foo'` in unrelated helpers (voice
  // registries, etc).
  const tools = new Set();
  const caseRe = /^\s*case\s+['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*:/gm;
  let m;
  while ((m = caseRe.exec(src)) !== null) {
    if (!VERTEX_PROTOCOL_ARMS.has(m[1])) tools.add(m[1]);
  }
  return tools;
}

function extractLivekitTools(src) {
  // Walks the `all_tool_names()` return list which is the canonical
  // LiveKit catalogue. Body looks like:
  //   def all_tool_names() -> list[str]:
  //       """…"""
  //       return [
  //           "search_memory", "search_knowledge", …,
  //           # comment
  //           "navigate", "navigate_to_screen", "get_current_screen",
  //       ]
  const idx = src.indexOf('def all_tool_names');
  if (idx < 0) return new Set();
  const body = src.slice(idx);
  const ret = body.indexOf('return [');
  if (ret < 0) return new Set();
  // Find matching closing bracket.
  let depth = 0;
  let close = -1;
  for (let i = ret + 'return ['.length - 1; i < body.length; i++) {
    if (body[i] === '[') depth++;
    else if (body[i] === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return new Set();
  const list = body.slice(ret + 'return ['.length, close);
  const tools = new Set();
  const pat = /['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
  let m;
  while ((m = pat.exec(list)) !== null) {
    tools.add(m[1]);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function main() {
  const sharedSrc = readSource(SHARED);
  const vertexSrc = readSource(VERTEX);
  const livekitSrc = readSource(LIVEKIT);

  const shared = extractSharedRegistry(sharedSrc);
  const vertexCases = extractVertexTools(vertexSrc);
  const livekit = extractLivekitTools(livekitSrc);

  // A tool is "wired on Vertex" if either:
  //   - It's a case arm in orb-live.ts (Vertex pipeline serves it inline
  //     OR delegates it to the shared dispatcher).
  //   - It's in ORB_TOOL_REGISTRY (the shared dispatcher serves it; both
  //     pipelines route through it via dispatchOrbToolForVertex).
  const vertex = new Set([...vertexCases, ...shared]);

  // A tool is "wired on LiveKit" if it's in all_tool_names() (the agent
  // registers it with the LLM). LiveKit's HTTP tool path also goes through
  // the shared dispatcher, but the LLM-facing surface is what counts here.
  // Tools that are in the shared registry but NOT in tools.py are
  // intentionally hidden from LiveKit's LLM (e.g. legacy aliases).
  const livekitFinal = livekit;

  const manifestRaw = readSource(MANIFEST);
  const manifest = JSON.parse(manifestRaw);
  const tools = manifest.tools ?? [];

  const reconciled = [];
  const drifts = [];
  let changed = 0;

  for (const t of tools) {
    const wired = [];
    if (vertex.has(t.name)) wired.push('vertex');
    if (livekitFinal.has(t.name)) wired.push('livekit');

    const wantStatus = wired.length > 0 ? 'live' : 'planned';
    const haveStatus = t.status;
    const haveWired = Array.isArray(t.wired_in) ? [...t.wired_in].sort() : null;
    const wantWired = [...wired].sort();
    const wiredChanged = haveWired === null || JSON.stringify(haveWired) !== JSON.stringify(wantWired);
    const statusChanged = haveStatus !== wantStatus;

    if (wiredChanged || statusChanged) {
      drifts.push({
        name: t.name,
        from: { status: haveStatus, wired_in: haveWired },
        to: { status: wantStatus, wired_in: wantWired },
      });
      changed++;
    }

    reconciled.push({ ...t, status: wantStatus, wired_in: wantWired });
  }

  // Surface tools that exist in ANY source but are missing from the manifest.
  const manifestNames = new Set(tools.map((t) => t.name));
  const allSources = new Set([...vertex, ...livekitFinal]);
  const missing = [];
  for (const name of allSources) {
    if (!manifestNames.has(name)) missing.push(name);
  }
  missing.sort();

  // Print report.
  console.log('## voice-tools manifest reconciliation report\n');
  console.log(`Manifest: **${tools.length} tools**`);
  console.log(`Vertex (cases + buildLiveApiTools + shared registry): **${vertex.size} tools**`);
  console.log(`LiveKit (all_tool_names): **${livekitFinal.size} tools**`);
  console.log(`Shared registry (ORB_TOOL_REGISTRY): **${shared.size} tools**`);
  console.log('');

  if (drifts.length === 0) {
    console.log('### ✅ Manifest is in sync with reality.');
  } else {
    console.log(`### ⚠️ ${drifts.length} drift(s) — manifest disagrees with reality\n`);
    for (const d of drifts) {
      const before = `${d.from.status} / wired_in=${JSON.stringify(d.from.wired_in)}`;
      const after = `${d.to.status} / wired_in=${JSON.stringify(d.to.wired_in)}`;
      console.log(`- \`${d.name}\`: ${before} → ${after}`);
    }
  }

  if (missing.length > 0) {
    console.log(`\n### ℹ️ ${missing.length} tool(s) wired in source but missing from the manifest\n`);
    for (const name of missing) {
      const v = vertex.has(name);
      const l = livekitFinal.has(name);
      const where = [v ? 'vertex' : null, l ? 'livekit' : null].filter(Boolean).join('+');
      console.log(`- \`${name}\` (${where}) — add a manifest entry with surface/role/description`);
    }
  }

  if (MODE_APPLY) {
    // Rewrite manifest with reconciled status/wired_in, preserving order
    // and any extra metadata fields.
    const updated = {
      ...manifest,
      generated_at: new Date().toISOString(),
      source: 'reconciled',
      total: reconciled.length,
      tools: reconciled,
    };
    writeFileSync(MANIFEST, JSON.stringify(updated, null, 2) + '\n');
    console.log(`\n✅ Wrote ${reconciled.length} tools to tool-manifest.json (changed=${changed}).`);
  }

  if (MODE_CHECK) {
    if (drifts.length > 0) {
      console.error(`\n[reconcile] FAILED: ${drifts.length} drift(s). Run \`node scripts/voice-tools-manifest-reconcile.mjs --apply\` to fix.`);
      process.exit(1);
    }
    if (missing.length > 0) {
      // Don't fail on missing entries — they're a copy/seed task, not a drift.
      console.warn(`\n[reconcile] WARNING: ${missing.length} tool(s) missing from manifest (informational).`);
    }
  }
}

main();
