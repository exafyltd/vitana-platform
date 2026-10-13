#!/usr/bin/env node
/**
 * VTID-05150 — provision a tenant through the gateway API (exafy_admin only).
 *
 *   VITANA_ADMIN_JWT=<exafy_admin access token> \
 *     node scripts/tenants/provision-tenant.mjs --gateway <https://gateway-host> --pack <pack.json> \
 *       [--assets <dir>] [--readiness-only]
 *
 * Steps (each idempotent, so a re-run after a failure is safe):
 *   1. POST  /api/v1/admin/tenants              (provision_tenant: tenant, settings,
 *                                                instance data, first-admin invitation)
 *   2. PATCH /api/v1/admin/tenants/<id>         (the brand pack; never open_signup here)
 *   3. PUT   /api/v1/admin/tenants/<id>/assets/<kind>  for logo / favicon / og_image
 *      found in --assets (<kind>.png|jpg|jpeg|webp)
 *   4. GET   /api/v1/admin/tenants/<id>/readiness, printed as a checklist
 * and prints the invitation accept path for the operator to deliver to the
 * first admin (there is no invitation email yet).
 *
 * --readiness-only skips 1-3 and prints readiness for pack.provision.slug.
 *
 * Pack file (reviewed and approved by the owner first — RUNBOOK-provision.md):
 *   {
 *     "provision":  { "slug", "name", "admin_email", "all_members_group_name",
 *                     "display_name"?, "jev_monthly_budget_usd"?, "default_locale"?,
 *                     "enabled_locales"?, "timezone"?, "currency"? },
 *     "brand_pack": { "brand"?: { "colors": { "accent", "bg", "fg" } }, "legal_entity_line"?,
 *                     "support_email"?, "sender_name"?, "sender_email"?, "landing"?,
 *                     "persona_facts"? }   // facts only, never a sentence Vitana speaks
 *   }
 *
 * No default host: --gateway is required (never hardcode URLs). The JWT is
 * read from the environment and never printed.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const ASSET_KINDS = ['logo', 'favicon', 'og_image'];
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function parseArgs(argv) {
  const out = { readinessOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gateway') out.gateway = argv[++i];
    else if (a === '--pack') out.pack = argv[++i];
    else if (a === '--assets') out.assets = argv[++i];
    else if (a === '--readiness-only') out.readinessOnly = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.gateway || !/^https?:\/\//.test(out.gateway)) throw new Error('--gateway <http(s)://host> is required');
  if (!out.pack) throw new Error('--pack <file.json> is required');
  return out;
}

/** <kind>.<ext> files in the assets dir → [{kind, file, type}]. */
export function findAssets(dir) {
  if (!dir) return [];
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^(logo|favicon|og_image)\.([a-z]+)$/i);
    if (!m) continue;
    const type = EXT_TYPE[m[2].toLowerCase()];
    if (!type) throw new Error(`${name}: only png, jpg/jpeg, webp are accepted`);
    found.push({ kind: m[1].toLowerCase(), file: path.join(dir, name), type });
  }
  return found;
}

async function call(base, jwt, method, p, body, contentType = 'application/json') {
  const res = await fetch(`${base.replace(/\/+$/, '')}${p}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: `non-JSON response (${res.status})` }; }
  return { status: res.status, json };
}

function printReadiness(r) {
  console.log(`\nReadiness for ${r.slug}: ${r.ready ? 'READY' : 'NOT READY'}${r.legacy ? ' (legacy tenant)' : ''}${r.schema_missing ? ' (schema missing)' : ''}`);
  for (const c of r.checks || []) console.log(`  ${c.informational ? 'i' : c.ok ? '✓' : '✗'} ${c.key} — ${c.detail}`);
}

export async function run(opts, env = process.env) {
  const jwt = env.VITANA_ADMIN_JWT;
  if (!jwt) throw new Error('VITANA_ADMIN_JWT (an exafy_admin access token) is required');
  const pack = JSON.parse(fs.readFileSync(opts.pack, 'utf8'));
  if (!pack.provision?.slug) throw new Error('pack.provision.slug is required');
  const base = `/api/v1/admin/tenants`;
  let tenantId = pack.provision.slug;

  if (!opts.readinessOnly) {
    const p = await call(opts.gateway, jwt, 'POST', base, pack.provision);
    if (p.status !== 201 && p.status !== 200) throw new Error(`provision failed (${p.status}): ${p.json.error || ''}`);
    tenantId = p.json.tenant_id;
    console.log(`${p.json.created ? 'Created' : 'Already provisioned'}: ${p.json.slug} (${tenantId})`);
    console.log(`Ensured: ${JSON.stringify(p.json.ensured)}`);
    if (p.json.invitation?.accept_path) {
      console.log(`First-admin invitation ${p.json.invitation.reused ? '(reused)' : '(new)'}, expires ${p.json.invitation.expires_at}`);
      console.log(`  accept path: ${p.json.invitation.accept_path}`);
    }

    if (pack.brand_pack && Object.keys(pack.brand_pack).length) {
      const { open_signup: _ignored, ...packOnly } = pack.brand_pack;
      const r = await call(opts.gateway, jwt, 'PATCH', `${base}/${tenantId}`, packOnly);
      if (r.status !== 200) throw new Error(`brand pack failed (${r.status}): ${r.json.error || ''} ${JSON.stringify(r.json.issues || '')}`);
      console.log(`Brand pack: ${r.json.updated_fields.join(', ')}`);
    }

    for (const a of findAssets(opts.assets)) {
      const r = await call(opts.gateway, jwt, 'PUT', `${base}/${tenantId}/assets/${a.kind}`, fs.readFileSync(a.file), a.type);
      if (r.status !== 200) throw new Error(`asset ${a.kind} failed (${r.status}): ${r.json.error || ''}`);
      console.log(`Asset ${a.kind}: ${r.json.path}`);
    }
  }

  const rd = await call(opts.gateway, jwt, 'GET', `${base}/${tenantId}/readiness`);
  if (rd.status !== 200) throw new Error(`readiness failed (${rd.status}): ${rd.json.error || ''}`);
  printReadiness(rd.json);
  return rd.json;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[VTID-05150] ${err.message}`);
    process.exit(2);
  }
  run(opts)
    .then(() => process.exit(0))
    .catch((err) => { console.error(`[VTID-05150] ${err.message}`); process.exit(1); });
}
