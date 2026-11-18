# Sparring round 2 — in_progress

Session: `0725552c-f9b6-4000-950d-754ab437858f` · plan hash `661685f6679e143d1b36842940a73b78ad0d40933126a3cd1511a598ca01263a`

## Summary

Round 2 review of the revised mt-network plan. All three R1 findings were accepted by the planner; I verified the corrections against the pinned platform commit. The writer inventory is now comprehensive and accurate — every file/line I checked matches. The `/vitana-reply` line reference is fixed. The v1 repo remains unpinned in this session so I still cannot independently verify v1 premises, but the planner's corrections (daily_matches schema, p_visibility location, etc.) are internally consistent with what I can see on the platform side. I found one new major gap (expand/contract scope default vs. system writers) and one minor inconsistency (line reference).

## Findings

### R2-F1 [major]

The expand/contract pattern for `chat_messages.scope` will break the five allowlisted system writers when the DEFAULT is dropped. The plan adds `scope text NOT NULL DEFAULT 'community'` (expand), then drops the default (contract). The plan explicitly classifies the system writers — `insertVitanaReplyMessage` (chat-repository.ts:92), `insertCompanionChatMessage` (companion-repository.ts:400), `insertProactiveMatchChatMessage` (proactive-match-messenger-repository.ts:58), `insertWelcomeChatMessagesBatch` (welcome-chat-service-repository.ts:52), and `insertWelcomeChatMessage` (welcome-team-repository.ts:147) — as 'files not edited'. None of these currently include a `scope` field in their insert payloads. Once the DEFAULT is dropped, every bare `.from('chat_messages').insert(payload)` that omits `scope` will fail with a NOT NULL violation. The member-on-behalf path is covered by the new `send_message`/`send_message_as` RPCs, but the system writers are explicitly NOT routed through those RPCs.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat-repository.ts:92` — export function insertVitanaReplyMessage(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('chat_messages').insert(row);
}
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-repository.ts:396` — export async function insertCompanionChatMessage(
  sb: SupabaseClient,
  row: CompanionChatMessageRow,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb.from('chat_messages').insert(row).select('id').single();
- `exafyltd/vitana-platform:services/gateway/src/services/proactive-match-messenger-repository.ts:54` — export function insertProactiveMatchChatMessage(
  sb: SupabaseClient,
  payload: { tenant_id: string; sender_id: string; receiver_id: string; content: string; message_type: string; metadata: Record<string, unknown> },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_messages').insert(payload);
}
- `exafyltd/vitana-platform:services/gateway/src/services/welcome-chat-service-repository.ts:51` — export async function insertWelcomeChatMessagesBatch(sb: SupabaseClient, batch: unknown[]) {
  return sb.from('chat_messages').insert(batch as any);
}
- `exafyltd/vitana-platform:services/gateway/src/services/welcome-team/welcome-team-repository.ts:143` — export async function insertWelcomeChatMessage(
  sb: SupabaseClient,
  row: WelcomeChatMessageRow,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb.from('chat_messages').insert(row).select('id').single();

Suggestion: Either (a) keep the DEFAULT 'community' permanently (do not contract) since all system writers are community-only by definition, or (b) add the five system-writer files to the `messaging-send-gateway` lane's `paths` so each insert payload includes `scope: 'community'` before the contract migration runs, removing the 'files not edited' classification. Option (a) is simpler and still enforces the CHECK constraint.

### R2-F2 [minor]

The `messaging-send-gateway` fix bullet references `/send` as `chat.ts:54`, but the plan's own corrections section says `/send` is at `chat.ts:124`. The actual handler is at line 124, confirmed by read_file. This is a self-contradiction within the revised plan.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat.ts:122` — // ── POST /send — Send a direct message ───────────────────────

router.post('/send', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

Suggestion: Update the fix bullet to `chat.ts:124` to match both the corrections section and the actual code.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The full grep-derived inventory is now in the plan with correct file paths and line numbers, all verified against the pinned commit. The lint regenerates at test time, preventing stale inventories.
- R1-F2: acknowledged — Accepted and addressed. The planner re-verified all v1 premises and made substantive corrections (daily_matches has no unique key or tenant_id; p_visibility default is on search_intent_catalog not compute_intent_matches). The v1 repo is not pinned in this review session so I cannot independently confirm, but the corrections are internally consistent with what is visible on the platform side.
- R1-F3: acknowledged — Accepted and addressed. The plan now correctly references /vitana-reply at chat.ts:441, insertVitanaReplyMessage at chat-repository.ts:92-93, and the call site at chat.ts:839. All verified.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
