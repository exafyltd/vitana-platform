# Sparring round 3 — converged

Session: `0725552c-f9b6-4000-950d-754ab437858f` · plan hash `7106f262f1a6aedb9d2161450d891122be2877c3c70c2bce0a27fabf07139e52`

## Summary

Round 3 review of the revised mt-network plan. Both R2 findings were accepted and properly addressed in the revision. The chat_messages writer inventory is now comprehensive and matches the pinned codebase (all 11 insert-site files confirmed). The expand/contract pattern is correctly gated on the writer lint. Line references are consistent. One new minor finding on the M3 (flagged) chat_group_members inventory.

## Findings

### R3-F1 [minor]

The M3 network-groups plan states 'Membership changes go only through the DEFINER `add_group_member()`, which `routes/chat-groups-repository.ts` calls (dark)' and 'A Jest lint fails on any `.from("chat_group_members")` insert/upsert/delete outside that wrapper.' However, `chat-groups-repository.ts` has NO `chat_group_members` insert or delete — only reads and an UPDATE (line 111-117, `markChatGroupRead`). The actual `chat_group_members` write sites on `main` are: (1) `community-group-enrollment-repository.ts:35` (`insertGroupMembership` — system enrollment), (2) `messaging-depth-tools-repository.ts:94-101` (`insertChatGroupMember` — ORB group tools), and (3) `messaging-depth-tools-repository.ts:104-106` (`deleteChatGroupMembership`). Without inventorying and classifying these (as the plan does for `chat_messages`), the M3 lint allowlist and the migration to `add_group_member()` will miss or misattribute call sites.

- `exafyltd/vitana-platform:services/gateway/src/routes/chat-groups-repository.ts:110` — export async function markChatGroupRead(sb: SupabaseClient, groupId: string, userId: string) {
  return sb
    .from('chat_group_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', userId);
}
- `exafyltd/vitana-platform:services/gateway/src/services/community-group-enrollment-repository.ts:31` — export async function insertGroupMembership(
  sb: SupabaseClient,
  row: { group_id: string; user_id: string; tenant_id: string; role: string },
) {
  return sb.from('chat_group_members').insert(row);
}
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/messaging-depth-tools-repository.ts:94` — export function insertChatGroupMember(
  sb: SupabaseClient,
  groupId: string,
  userId: string,
  tenantId: string,
  role: string,
): PromiseLike<{ error: { message: string; code?: string } | null }> {
  return sb.from('chat_group_members').insert({ group_id: groupId, user_id: userId, tenant_id: tenantId, role });
}

export function deleteChatGroupMembership(sb: SupabaseClient, groupId: string, userId: string): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('chat_group_members').delete().eq('group_id', groupId).eq('user_id', userId);
}

Suggestion: Add a ground-truth `chat_group_members` writer inventory to the M3 network-groups lanes (parallel to the `chat_messages` inventory), listing the three write sites and classifying each: `community-group-enrollment-repository.ts:35` (system enrollment — likely allowlisted), `messaging-depth-tools-repository.ts:94-101` (ORB member-on-behalf — route through `add_group_member()`), and `messaging-depth-tools-repository.ts:104-106` (ORB leave — needs a corresponding `remove_group_member()` DEFINER or allowlist). Update the plan text to reference the correct current files.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Properly addressed. The plan now requires all five system writers to set scope:'community' explicitly, adds three previously-missing files to the lane paths, and gates the contract migration on the writer lint. Confirmed all five insert sites still lack scope on the pinned commit.
- R2-F2: acknowledged — Properly addressed. The plan consistently references chat.ts:124 for the /send handler.
