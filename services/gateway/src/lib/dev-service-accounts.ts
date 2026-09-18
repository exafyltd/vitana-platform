/**
 * Dev/automation service accounts — never surfaced in a community member's
 * chat inbox. These exist purely for internal engineering/autopilot work
 * (e.g. the OASIS worker/executor plane, VTID-03516) and are not community
 * members. A 2026-09-16 bootstrap step had two of them each send a
 * "Hello! My name is ..." intro DM to every community member, landing a
 * dev-only thread in 222+ real users' chat_messages-backed inboxes
 * (VTID-03982).
 *
 * Keyed by user_id, mirroring exafyltd/vitana-v1's
 * src/lib/devServiceAccounts.ts — new accounts must be added to both.
 */
export const DEV_SERVICE_ACCOUNT_ID_LIST = [
  '887b34cb-9ee9-47dc-ad53-db5be1869846', // claude-code-agent@exafy.io
  '856c30ed-7136-4bc5-8bfe-86a1e8ea1401', // operator-autopilot@exafy.io
] as const;

const DEV_SERVICE_ACCOUNT_IDS = new Set<string>(DEV_SERVICE_ACCOUNT_ID_LIST);

export function isDevServiceAccount(userId: string | null | undefined): boolean {
  return !!userId && DEV_SERVICE_ACCOUNT_IDS.has(userId);
}
