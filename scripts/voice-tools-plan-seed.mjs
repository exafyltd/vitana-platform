#!/usr/bin/env node
/**
 * BOOTSTRAP-VOICE-CATALOG-V2-PLAN — seed the approved expansion catalog.
 *
 * Parses docs/VOICE_TOOLS_EXPANSION_PLAN.md (the approved 425-tool plan)
 * and merges every tool into services/gateway/src/services/tool-manifest.json
 * as `status: "planned"`, `wired_in: []`, so the Command Hub Tool Catalog
 * shows the full roadmap. The plan document is the source of truth: re-run
 * this script after editing the plan tables and commit the regenerated
 * manifest.
 *
 * Idempotent: entries whose name already exists in the manifest are left
 * untouched (never downgrades a live tool back to planned). Hard-fails on
 * duplicate names inside the plan or a per-section count mismatch, so a
 * mis-edited table cannot silently corrupt the catalog.
 *
 * Usage: node scripts/voice-tools-plan-seed.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAN = resolve(ROOT, 'docs/VOICE_TOOLS_EXPANSION_PLAN.md');
const MANIFEST = resolve(ROOT, 'services/gateway/src/services/tool-manifest.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Section id → catalog metadata. Roles follow the plan's parts:
// A* community, B* admin, C* developer (same gating as the existing 169).
const PART_META = {
  A: { roles: ['community'], surfaceDefault: 'Community' },
  B: { roles: ['admin', 'exafy_admin'], surfaceDefault: 'Admin' },
  C: { roles: ['developer', 'admin', 'exafy_admin'], surfaceDefault: 'Developer' },
};

// Community sections get real surfaces so the catalog filter stays useful;
// admin/developer keep their part-wide surface (matches the existing 9/12).
const SECTION_SURFACE = {
  A1: 'Marketplace', A2: 'Marketplace', A3: 'Wallet', A4: 'Billing',
  A5: 'Referrals', A6: 'Business', A7: 'LiveRooms', A8: 'Chat',
  A9: 'Community', A10: 'Events', A11: 'Health', A12: 'Goals',
  A13: 'Memory', A14: 'Profile', A15: 'Campaigns', A16: 'Settings',
  // Marketplace Voice Assistant — expansion v3 (A17–A30 in the same plan doc)
  A17: 'Marketplace', A18: 'Marketplace', A19: 'Marketplace', A20: 'Marketplace',
  A21: 'Marketplace', A22: 'Marketplace', A23: 'Marketplace', A24: 'Marketplace',
  A25: 'Marketplace', A26: 'Marketplace', A27: 'Marketplace', A28: 'Marketplace',
  A29: 'Marketplace', A30: 'Marketplace',
};

// Section id → plan tag. A17+ belong to the Marketplace Voice Assistant
// expansion (v3); everything before it is the original 425-tool plan (v2).
const planTag = (sectionId) => (Number(sectionId.slice(1)) >= 17 && sectionId[0] === 'A' ? 'marketplace-va-v3' : 'expansion-v2');

const SECTION_RE = /^## ([ABC]\d+)\.\s+(.+?)\s+\((\d+)\)\s+—\s+(P\d)/;
const ROW_RE = /^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*(⚠️⚠️|⚠️)?\s*\|\s*(.+?)\s*\|\s*(R|W)\s*\|/;

function parsePlan(md) {
  const tools = [];
  let section = null;
  let sectionCount = 0;
  const counts = [];

  const flush = () => {
    if (section) counts.push({ id: section.id, expected: section.expected, got: sectionCount });
  };

  for (const line of md.split('\n')) {
    const h = line.match(SECTION_RE);
    if (h) {
      flush();
      section = { id: h[1], title: h[2], expected: Number(h[3]), priority: h[4] };
      sectionCount = 0;
      continue;
    }
    if (!section) continue;
    const r = line.match(ROW_RE);
    if (!r) continue;
    const [, name, warn, description, rw] = r;
    const risk =
      warn === '⚠️⚠️' ? 'double_confirm'
      : warn === '⚠️' ? 'confirm'
      : rw === 'W' ? 'write'
      : 'read';
    const part = section.id[0];
    const meta = PART_META[part];
    tools.push({
      name,
      surface: SECTION_SURFACE[section.id] ?? meta.surfaceDefault,
      category: part === 'A' ? 'community' : part === 'B' ? 'admin' : 'developer',
      role: meta.roles,
      status: 'planned',
      description,
      wired_in: [],
      priority: section.priority,
      risk,
      plan_domain: `${section.id} ${section.title}`,
      plan: planTag(section.id),
    });
    sectionCount++;
  }
  flush();

  const bad = counts.filter((c) => c.expected !== c.got);
  if (bad.length) {
    for (const b of bad) console.error(`[seed] section ${b.id}: header says ${b.expected}, parsed ${b.got}`);
    throw new Error('section count mismatch — fix the plan tables or headers');
  }

  const seen = new Set();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`duplicate tool in plan: ${t.name}`);
    seen.add(t.name);
  }
  return tools;
}

function main() {
  const parsed = parsePlan(readFileSync(PLAN, 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const existing = new Set(manifest.tools.map((t) => t.name));

  // Idempotent (per the header contract): plan entries whose name already
  // exists in the manifest are skipped, never touched — re-running after a
  // previous seed (or after a wave went live) must not downgrade or duplicate.
  const skipped = parsed.filter((t) => existing.has(t.name));
  const planned = parsed.filter((t) => !existing.has(t.name));
  if (skipped.length) {
    console.log(`[seed] skipping ${skipped.length} plan entries already in the manifest (idempotent re-run)`);
  }

  const byPart = { A: 0, B: 0, C: 0 };
  for (const t of planned) byPart[t.plan_domain[0]]++;
  console.log(`[seed] parsed ${planned.length} new planned tools (community=${byPart.A}, admin=${byPart.B}, developer=${byPart.C})`);

  if (DRY_RUN) {
    console.log('[seed] dry-run: manifest not written');
    return;
  }

  const tools = [...manifest.tools, ...planned];
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      { ...manifest, generated_at: new Date().toISOString(), source: 'reconciled+plan-seed', total: tools.length, tools },
      null,
      2,
    ) + '\n',
  );
  console.log(`[seed] wrote ${tools.length} tools to tool-manifest.json (+${planned.length} planned)`);
}

main();
