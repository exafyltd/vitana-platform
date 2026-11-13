/**
 * VTID-05658 — read-only adoption counts. The SQL (adoption.sql) returns per-member facts; this module
 * classifies each member and returns aggregates only.
 *
 *   native  — a `native` row in the window (wins over everything else)
 *   appilix — an un-revoked `Appilix %` device token and NO `native` row in the window
 *   web     — neither
 */
export interface MemberFacts {
  tenant_id: string;
  user_id: string;
  has_native: boolean;
  has_web: boolean;
  has_appilix: boolean;
}

export type MemberClass = 'native' | 'appilix' | 'web';

export interface AdoptionCounts {
  native: number;
  appilix: number;
  web: number;
  total: number;
  /** native / (native + appilix + web), 0 when nobody was seen */
  native_share: number;
  /** members with an un-revoked Appilix token that were also seen on native */
  native_and_appilix: number;
}

/** Runs the SQL text with positional params; returns rows. Injectable (Aurora pool in prod, double in tests). */
export type AdoptionQueryRunner = (sql: string, params: unknown[]) => Promise<MemberFacts[]>;

export function classifyMember(f: Pick<MemberFacts, 'has_native' | 'has_appilix'>): MemberClass {
  if (f.has_native) return 'native';
  if (f.has_appilix) return 'appilix';
  return 'web';
}

export function summarizeAdoption(rows: MemberFacts[]): AdoptionCounts {
  const c: AdoptionCounts = { native: 0, appilix: 0, web: 0, total: 0, native_share: 0, native_and_appilix: 0 };
  for (const r of rows) {
    c[classifyMember(r)] += 1;
    if (r.has_native && r.has_appilix) c.native_and_appilix += 1;
    c.total += 1;
  }
  c.native_share = c.total === 0 ? 0 : c.native / c.total;
  return c;
}

/**
 * Same statement as adoption.sql (the build does not copy .sql files into dist, so it is embedded;
 * a test keeps the two identical).
 */
export const ADOPTION_SQL = `SELECT
  s.tenant_id,
  s.user_id,
  bool_or(s.client_class = 'native') AS has_native,
  bool_or(s.client_class = 'web')    AS has_web,
  EXISTS (
    SELECT 1
      FROM user_device_tokens t
     WHERE t.user_id = s.user_id
       AND t.revoked_at IS NULL
       AND t.device_label LIKE 'Appilix %'
  ) AS has_appilix
FROM client_identity_daily_seen s
WHERE s.day >= $1::date
  AND s.day <  $2::date
GROUP BY s.tenant_id, s.user_id;
`;

/** Window is [from, to) in UTC days (YYYY-MM-DD). */
export async function getAdoptionCounts(run: AdoptionQueryRunner, from: string, to: string): Promise<AdoptionCounts> {
  return summarizeAdoption(await run(ADOPTION_SQL, [from, to]));
}
