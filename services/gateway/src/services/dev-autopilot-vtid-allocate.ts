/**
 * VTID-04246: a real VTID for every auto-approved Dev Autopilot finding.
 *
 * Live 2026-09-21 (docs/validation/VTID-04246/): the first six auto-approved
 * executions were approved by the owner, opened PRs #3543–#3548, and every
 * one failed VALIDATOR-CHECK on exit 10 ("no VTID in the title, and no
 * explicit 'VTID: VTID-XXXXX' line in the body") inside a minute, was
 * reverted, and spawned a self-heal child that the PR-flood guard then
 * refused. Cause: autoApproveTick never activates a VTID for the finding,
 * so `applyPrContract` (VTID-04002) skips itself ("no real VTID (finding
 * has no activated_vtid)") and the PR ships with the `VTID-DA-<exec8>`
 * placeholder — structurally unmergeable on this repo. The operator on-ramp
 * (VTID-04005) and the self-healing injector already allocate; auto-approve
 * was the one producer that did not.
 *
 * Same contract as the on-ramp's allocateAndRegisterVtid: the
 * `allocate_global_vtid` RPC mints the number and the ledger shell in one
 * transaction; the follow-up PATCH registers a real title and marks the row
 * `in_progress`/`approved` (the owner enabled auto-approve — that is the
 * approval, CLAUDE.md §4.1). The finding is then stamped with
 * `activated_vtid`/`activated_at` while its `status` stays `new`, so the
 * activated-orphan reaper (which selects `status=eq.activated`) never sees
 * it and approveAutoExecute's `status !== 'new'` guard is untouched.
 *
 * Any failure returns `{ ok: false }` and the caller SKIPS the approval —
 * running an execution that cannot produce a mergeable PR only burns
 * tokens (the exact loop this VTID closes). The ledger metadata carries
 * `source: 'dev-autopilot-auto-approve'` and deliberately NOT
 * `autonomous_execution: true` — that flag is the worker-runner's claim
 * allowlist (VTID-03516) and would let the legacy plane pick the VTID up.
 */

import type { SupaConfig } from './dev-autopilot-execute';

// Plain fetch on purpose: dev-autopilot-execute.ts imports this module, so
// importing its `supa` helper back would be a require cycle.
async function patch(s: SupaConfig, path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${s.url}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: s.key, Authorization: `Bearer ${s.key}`, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  return r.ok ? { ok: true } : { ok: false, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
}

const LOG_PREFIX = '[dev-autopilot-vtid]';

export type FindingVtidInput = {
  findingId: string;
  title: string;
  summary: string;
  scanner: string | null;
  /**
   * VTID-04308: other producers (feedback tickets) reuse this allocator.
   * Defaults keep the auto-approve ledger shape byte-identical.
   */
  source?: string;
  module?: string;
  purpose?: string;
  extraMetadata?: Record<string, unknown>;
};

export type FindingVtidResult = { ok: true; vtid: string } | { ok: false; error: string };

/** Title for the ledger row: the finding's own title when it has one. */
export function buildFindingVtidTitle(spec: Record<string, unknown> | null | undefined, findingId: string, scanner: string | null): string {
  const raw = spec && typeof spec === 'object'
    ? (spec as Record<string, unknown>).title ?? (spec as Record<string, unknown>).summary ?? (spec as Record<string, unknown>).message
    : null;
  const t = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  const base = t.length > 0 ? t : `Dev Autopilot finding ${findingId.slice(0, 8)}`;
  const prefix = `Dev Autopilot (${scanner || 'auto-approve'}): `;
  return (prefix + base).slice(0, 200);
}

export async function allocateAndRegisterFindingVtid(s: SupaConfig, input: FindingVtidInput): Promise<FindingVtidResult> {
  try {
    const rpc = await fetch(`${s.url}/rest/v1/rpc/allocate_global_vtid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: s.key, Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ p_source: 'dev-autopilot', p_layer: 'DEV', p_module: input.module ?? 'auto-approve' }),
    });
    if (!rpc.ok) {
      return { ok: false, error: `vtid_allocation_failed: ${rpc.status} ${(await rpc.text()).slice(0, 200)}` };
    }
    const rows = (await rpc.json()) as Array<{ vtid?: string }>;
    const vtid = rows && rows[0] && typeof rows[0].vtid === 'string' ? rows[0].vtid : null;
    if (!vtid || !/^VTID-\d{4,5}$/.test(vtid)) {
      return { ok: false, error: 'vtid_allocation_failed: allocator returned no VTID' };
    }

    const ledger = await patch(s, `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`, {
        title: input.title,
        summary: input.summary.slice(0, 500),
        status: 'in_progress',
        spec_status: 'approved',
        updated_at: new Date().toISOString(),
        metadata: {
          source: input.source ?? 'dev-autopilot-auto-approve',
          allocated_by: input.source ? input.source : 'autoApproveTick',
          finding_id: input.findingId,
          scanner: input.scanner,
          purpose: input.purpose ?? 'auto-approved Dev Autopilot execution (dev_autopilot_config.auto_approve_enabled)',
          ...(input.extraMetadata ?? {}),
        },
    });
    if (!ledger.ok) {
      return { ok: false, error: `vtid_registration_failed for ${vtid}: ${ledger.error || 'ledger PATCH failed'}` };
    }

    const finding = await patch(s, `/rest/v1/autopilot_recommendations?id=eq.${input.findingId}&activated_vtid=is.null`,
      { activated_vtid: vtid, activated_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (!finding.ok) {
      return { ok: false, error: `finding_stamp_failed for ${vtid}: ${finding.error || 'recommendation PATCH failed'}` };
    }
    console.log(`${LOG_PREFIX} ${vtid} allocated for finding ${input.findingId.slice(0, 8)} (${input.scanner || 'unknown scanner'})`);
    return { ok: true, vtid };
  } catch (err) {
    return { ok: false, error: `vtid_allocation_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
