/**
 * voice-experience-scanner-v1 (VTID-02866)
 *
 * Filesystem-only checks that the voice experience is wired correctly.
 * Findings flow into autopilot_recommendations with domain='voice' (after
 * dev-autopilot-synthesis.ts domainForPath update); the Voice Improve
 * cockpit reads them via /api/v1/voice/improvement/briefing source #6.
 *
 * Detectors (each is one finding):
 *
 *   1. awareness_not_wired_stale
 *      Awareness manifest entries with `wired: 'not_wired'` and no
 *      `enforcement_status: 'pending'` — these are signals that should
 *      either be wired or explicitly marked deferred.
 *
 *   2. watchdog_no_topic
 *      Awareness watchdog entries with no `oasis_topic` — they can never
 *      report `pass`; either define a topic or convert to a manual probe.
 *
 *   3. tts_speaking_rate_hardcoded
 *      `speakingRate:` numeric literals in voice TTS call sites — must
 *      read from getVoiceConfig() instead. Catches future regressions of
 *      the VTID-02857 wiring.
 *
 * NOT here (deliberately, to avoid duplication / coupling):
 *   - Voice routes missing auth — route-auth-scanner-v1 already covers it.
 *     Voice-specific auth nuance (e.g. "this route should require admin,
 *     not just any auth") can land in a future, more semantic detector.
 *   - DB-dependent checks (provider drift, failure-classes-without-rule)
 *     — live in the Voice Improve aggregator (PR A source #7) because they
 *     need runtime DB access and shouldn't couple scanner CI to gateway
 *     env vars.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'voice-experience-scanner-v1',
  signal_type: 'voice_health',
};

// ---------------------------------------------------------------------------
// 1. Awareness manifest stale not_wired
// ---------------------------------------------------------------------------
function detectAwarenessNotWired(repoRoot) {
  const file = path.join(
    repoRoot,
    'services/gateway/src/services/awareness-registry.ts',
  );
  const src = readFileSafe(file);
  if (!src) return [];
  // Heuristic parse: find each `{ key: '...', ..., wired: 'not_wired', ...}`
  // entry. We only need to catch ones that DON'T also carry
  // enforcement_status: 'pending'.
  const findings = [];
  const re = /\{\s*key:\s*'([^']+)'[^}]*?wired:\s*'not_wired'[^}]*?\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const block = m[0];
    if (block.includes("enforcement_status: 'pending'")) continue;
    findings.push({
      type: 'voice_health',
      severity: 'medium',
      file_path: relFromRepo(repoRoot, file),
      message: `Awareness signal '${m[1]}' marked wired:not_wired without enforcement_status:'pending'`,
      suggested_action: `Either wire signal ${m[1]} into the bootstrap context block, or mark enforcement_status:'pending' to declare it deferred.`,
      scanner: meta.scanner,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 2. Watchdog with no oasis_topic
// ---------------------------------------------------------------------------
function detectWatchdogNoTopic(repoRoot) {
  const file = path.join(
    repoRoot,
    'services/gateway/src/services/awareness-watchdogs.ts',
  );
  const src = readFileSafe(file);
  if (!src) return [];
  const findings = [];
  // Each watchdog is a literal object `{ id: '...', name: '...', ... }`
  // optionally containing `oasis_topic: '...'`. We extract objects by
  // scanning balanced braces in the WATCHDOGS array region.
  const arrStart = src.indexOf('const WATCHDOGS');
  if (arrStart < 0) return [];
  // Skip the type annotation (e.g. `: AwarenessWatchdog[]`) by anchoring
  // on `=` first; the array literal opens after that.
  const eqIdx = src.indexOf('=', arrStart);
  if (eqIdx < 0) return [];
  const arrOpen = src.indexOf('[', eqIdx);
  if (arrOpen < 0) return [];
  let depth = 0;
  let objStart = -1;
  for (let i = arrOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const block = src.slice(objStart, i + 1);
        const idMatch = block.match(/id:\s*'([^']+)'/);
        const id = idMatch ? idMatch[1] : '?';
        if (!/oasis_topic:/.test(block)) {
          findings.push({
            type: 'voice_health',
            severity: 'low',
            file_path: relFromRepo(repoRoot, file),
            message: `Watchdog '${id}' has no oasis_topic — it can never report 'pass'.`,
            suggested_action: `Define an oasis_topic for watchdog '${id}' or convert it to a manual probe with explicit unknown verdict.`,
            scanner: meta.scanner,
          });
        }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) {
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 3. TTS speakingRate hardcoded
// ---------------------------------------------------------------------------
function detectHardcodedSpeakingRate(repoRoot, files) {
  const findings = [];
  const re = /speakingRate:\s*([0-9]+(?:\.[0-9]+)?)/g;
  for (const f of files) {
    const rel = relFromRepo(repoRoot, f);
    if (!rel.endsWith('.ts')) continue;
    if (!rel.startsWith('services/gateway/src/')) continue;
    if (rel.includes('voice-config')) continue; // helper itself
    const src = readFileSafe(f);
    if (!src) continue;
    let m;
    while ((m = re.exec(src)) !== null) {
      const lineNumber = src.slice(0, m.index).split('\n').length;
      // Suppress if the literal sits inside a comment line.
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineEnd = src.indexOf('\n', m.index);
      const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // Suppress if this expression reads from voice-config.
      if (/getVoiceConfig|tts\.speaking_rate/.test(line)) continue;
      findings.push({
        type: 'voice_health',
        severity: 'medium',
        file_path: rel,
        line_number: lineNumber,
        message: `Hardcoded speakingRate: ${m[1]} — should read from getVoiceConfig()`,
        suggested_action: `Replace literal with await getVoiceConfig().tts.speaking_rate to honor the operator-tunable value.`,
        scanner: meta.scanner,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
export async function run({ files, repoRoot }) {
  const out = [];
  out.push(...detectAwarenessNotWired(repoRoot));
  out.push(...detectWatchdogNoTopic(repoRoot));
  out.push(...detectHardcodedSpeakingRate(repoRoot, files));
  return out;
}
