/**
 * VTID-05800: the VTID_ALLOCATOR_ENABLED env switch, read the same way everywhere.
 *
 * Allocation is on by default (owner decision 2026-11-15). The env var only matters when it is set:
 * 'true' forces allocation on, 'false' switches it off on purpose. Anything else, including unset, is null:
 * the Governance control decides, and a missing control means on.
 */
export function vtidAllocatorEnvSwitch(raw: string | undefined = process.env.VTID_ALLOCATOR_ENABLED): boolean | null {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
