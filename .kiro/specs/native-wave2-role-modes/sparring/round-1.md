# Sparring round 1 — in_progress

Session: `1bb1ca40-7a66-4f8d-9364-09f0323c637d` · plan hash `c0dc4918e55cb39db1164b438e0be28084c821e90195c899e7be18c2487949db`

## Summary

Verified 8+ premises. One critical finding: the plan's class-A classification of `role-switch-destination.ts` is incorrect — its runtime import of `getCommandHubUrl` from `devHub.config.ts` pulls in `import.meta.env` usage, which the extraction tooling classifies as class B. The planned core extraction would fail `core-closure.mjs --check`. Also, I could only verify 10 of the claimed 11 commerce/business role-modes rows (the `source: "exclusion"` row for `/commerce/connect/authorize` was not found in the sections I read). The remaining premises (resolver route, permissions re-export, admin scope, patient/professional/staff row counts and statuses) all hold.

## Findings

### R1-F1 [blocker]

role-switch-destination.ts is NOT class A. The plan states its imports are 'type-only UserRole + the pure getCommandHubUrl config → class A', but the import of getCommandHubUrl is a value import (not type-only): `import { getCommandHubUrl } from "@/config/devHub.config"`. devHub.config.ts uses `import.meta.env.VITE_DEV_HUB_ENABLED`, `import.meta.env.VITE_DEV_HUB_READONLY`, and `import.meta.env.VITE_GATEWAY_BASE` (lines 8-12), which triggers the `vite` signal in the extraction analysis (extraction-deps.mjs:207-211), making devHub.config.ts own-class B (extraction-deps.mjs:233). The core-closure BFS (core-closure.mjs:145-156) would traverse the non-type-only import, reach devHub.config.ts, find `m.own !== 'A'`, and emit an error. Therefore `core-closure.mjs --check` would FAIL if role-switch-destination.ts is added as a core re-export. The business lane's core extraction step as currently planned is broken.

- `exafyltd/vitana-v1:src/lib/role-switch-destination.ts:1` — import type { UserRole } from "@/hooks/useRole";
import { getCommandHubUrl } from "@/config/devHub.config";
- `exafyltd/vitana-v1:src/config/devHub.config.ts:6` — export const DEV_HUB_CONFIG = {
  // Feature flags
  enabled: import.meta.env.VITE_DEV_HUB_ENABLED !== 'false', // Default true
  readonly: import.meta.env.VITE_DEV_HUB_READONLY !== 'false', // Default true (Phase 1)
  
  // Gateway configuration (single source of truth)
  gatewayBase: import.meta.env.VITE_GATEWAY_BASE || null,
- `exafyltd/vitana-v1:scripts/native/extraction-deps.mjs:207` — if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const p = n.parent;
        const prop = p && ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text : 'meta';
        sig('vite', `import.meta.${prop}`, n);
      }
- `exafyltd/vitana-v1:scripts/native/extraction-deps.mjs:231` — export function ownClass(signals) {
    let c = 'A';
    for (const s of signals) c = worst(c, s.type === 'vite' || s.type === 'storage' || s.type === 'implicit-storage' || s.type === 'prod-fallback' ? 'B' : 'C');
    return c;
  }
- `exafyltd/vitana-v1:scripts/native/core-closure.mjs:145` — while (queue.length) {
      const at = queue.shift();
      for (const d of modules[at].imports) if (!closure.has(d)) { closure.add(d); parent.set(d, at); queue.push(d); }
    }
    const chainTo = (rel) => { const c = []; for (let x = rel; x; x = parent.get(x)) c.unshift(x); return c; };
    for (const rel of [...closure].sort()) {
      const m = modules[rel];
      if (!m) continue;
      if (m.own !== 'A') {
        const sig = m.signals.slice(0, 3).map((s) => `${s.type} \`${s.detail}\` L${s.line}`).join('; ');
        errors.push(`${rel} is class ${m.own} (${sig}) and core reaches it: ${chainTo(rel).join(' → ')}`);
      }
    }

Suggestion: Either (a) refactor role-switch-destination.ts to remove the runtime dependency on devHub.config.ts — e.g. accept getCommandHubUrl as an injected parameter/callback instead of importing it, so the core re-export is self-contained and class A; or (b) first promote devHub.config.ts to class A by replacing the import.meta.env reads with a configuration injection (matching the 'inject config' pattern the extraction docs describe for class B); or (c) do not extract role-switch-destination.ts into core at all, and re-implement the mapping natively in the business lane (same as the data hooks).

### R1-F2 [minor]

The plan claims 11 commerce/business rows in the ledger (34 source: role-route + 1 source: exclusion for /commerce/connect/authorize), but in the ledger regions I examined covering the full commerce role-route block (lines 4337-4455), I found only 10 commerce role-modes rows (all source: role-route). The /commerce/connect/authorize row with source: exclusion was not located. The plan should confirm the exact ledger line of this 11th row to prove the 8+8+8+11=35 partition.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:4337` — 10 commerce role-modes rows found: /commerce (4337), /commerce-login (4349), /commerce/connect (4361), /commerce/connect/privacy (4373), /commerce/connections/:id (4385), /commerce/health-orders (4397), /commerce/health-orders/inbox (4409), /commerce/invites/:token/accept (4421), /commerce/join (4433), /commerce/team (4445) — all source: role-route, lane: role-modes, status: not_started

Suggestion: Verify and cite the exact ledger location of the /commerce/connect/authorize exclusion row. If it exists in a separate section (e.g., between registry and role-route rows), confirm its lane is 'role-modes' and status is 'not_started'. If it does not exist, the count is 10 (not 11), making the total 34, and the plan's partition arithmetic needs correction.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
