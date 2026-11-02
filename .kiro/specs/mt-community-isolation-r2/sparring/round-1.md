# Sparring round 1 — in_progress

Session: `e768aae5-43ac-4bc7-9426-703e913aa5f2` · plan hash `958e38d491d97391a34e193e2b4d2ee816a120ac3275e9505d337c2d0426ecb2`

## Summary

Verified 8+ distinct premises against the pinned code. Most line-number references and structural claims hold. Two substantive findings: (1) the PostgREST `.or()` injection sanitization in `resolvePersonByName` must not be gated behind the dark feature flag—it's a live vulnerability today and should be fixed unconditionally; (2) the plan enumerates callers of `resolveMember` but not the transitive callers of `resolveAuthorPost` (a private helper that itself calls `resolveMember`), creating a risk of missed call sites. A couple of minor line-number inaccuracies noted.

## Findings

### R1-F1 [major]

The PostgREST `.or()` injection sanitisation in `resolvePersonByName` is described as part of the flag-gated `community-scope-gateway` lane. Today (line 652) only `%` and `_` are stripped, while line 658 directly interpolates user input into `.or(display_name.ilike.%${term}%,...)`. A hint containing `,` can inject additional filter clauses—this is a live information-disclosure vulnerability independent of multi-tenancy. If the fix is only applied when `feature_flags.mt.community_scope` is on (the lane is 'dark by default' until WS1 ships), the injection remains exploitable in production for an indeterminate period. The sanitisation (stripping `,()*.:\"`) must be unconditional—applied regardless of the feature flag state.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:649` — export async function resolvePersonByName(hint: string): Promise<SocialPerson | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const term = hint.trim().replace(/[%_]/g, '');
  if (term.length < 2) return null;

  const { data } = await supabase
    .from('profiles')
    .select(`${PROFILE_COLS}, full_name`)
    .or(`display_name.ilike.%${term}%,full_name.ilike.%${term}%,handle.ilike.%${term}%,vitana_id.ilike.%${term}%`)
    .limit(5);

Suggestion: Split the `.or()` sanitisation out of the flag-gated path. Apply the character-stripping fix unconditionally (even when the community_scope flag is off), so the injection is closed immediately on deploy. Only the `.in('user_id', memberIds)` tenant-scoping predicate should be conditional on the flag.

### R1-F2 [major]

The plan lists `resolveMember` at `p0-gap-tools.ts:71` as gaining an `id` parameter, passed from three callers: `tool_follow_member:90`, `tool_unfollow_member:127`, and `resolveAuthorPost:488`. However, `resolveAuthorPost` is itself a private helper (line 483) called from tool functions like `tool_like_post` (line 502+) and likely `tool_comment_post`, `tool_share_post`, etc. These transitive callers of `resolveAuthorPost` also need to thread `id` through, but they are not enumerated in the plan. Missing any of them will cause a compile-time break (changed signature) or a runtime undefined-tenantId bug.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/p0-gap-tools.ts:483` — async function resolveAuthorPost(
    sb: SupabaseClient,
    authorName: string,
    postReference: string,
  ): Promise<PostOutcome> {
    const author = await resolveMember(authorName);
    ...
  }

  export async function tool_like_post(
    args: OrbToolArgs,
    id: OrbToolIdentity,
    sb: SupabaseClient,
  ): Promise<OrbToolResult> {
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/p0-gap-tools.ts:70` — async function resolveMember(name: string): Promise<ResolvedPerson | null> {
    const { resolvePersonByName } = await import('../social-memory/social-memory-repository');
    const person = await resolvePersonByName(name);
    if (!person) return null;
    return { user_id: person.user_id, display_name: person.display_name ?? null };
  }

Suggestion: Enumerate all tool functions in `p0-gap-tools.ts` that call `resolveAuthorPost` (at minimum `tool_like_post`, and any `tool_comment_post`/`tool_share_post` if they exist) and confirm they pass `id` through `resolveAuthorPost` to `resolveMember`. Add them to the plan's caller list.

### R1-F3 [minor]

The plan claims `BuildPersonContextInput.tenant_id` is at `person-context-builder.ts:31`. The interface actually begins at line 35, with `tenant_id` at line 36.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/person-context-builder.ts:35` — export interface BuildPersonContextInput {
    tenant_id: string;
    user_id: string;
    /** Either a concrete user_id... */
    person_id?: string;
    /** ...or a fuzzy name/handle hint extracted from the question. */
    person_hint?: string;
  }

Suggestion: Update the line reference from `:31` to `:36`.

### R1-F4 [minor]

The plan cites `p_global: false` at `users-resolve-repository.ts:28`. It is actually at line 27.

- `exafyltd/vitana-platform:services/gateway/src/routes/users-resolve-repository.ts:23` — return sb.rpc('resolve_recipient_candidates', {
      p_actor: actorUserId,
      p_token: token,
      p_limit: limit,
      p_global: false,
    });

Suggestion: Update the line reference from `:28` to `:27`.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
