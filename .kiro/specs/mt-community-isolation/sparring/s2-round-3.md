# Sparring round 3 — escalated

Session: `ed136e24-677b-483e-92ea-78045c7b4748` · plan hash `e64d3489da4793a3d3bf3879673900eff5b4b05e6dcff6d540d17e1f4e83f94c`

## Summary

The revision correctly incorporated both round-2 findings: R2-F1 (connect-people daily_matches readers → (C)) and R2-F2 (fetchPeople(userIds, scope?) contract with threaded memberIds through internal call sites) are both addressed against code I verified. Two new issues remain. First, a material premise error: the plan claims resolvePersonByName is scoped "via fetchPersonById," but resolvePersonByName performs its own fuzzy `.or()` query on `profiles` (:655-659) and never calls fetchPersonById (or fetchPeople). With the flag on, cross-tenant profiles would still be returned by the name search, and the plan's stated propagation path is factually wrong about the call graph. Second, a minor gap: the (M) column enumeration omits `user_id_1`/`user_id_2`, so `fetchMatches`' `user_matches` read (`.or()` across two columns) has no specified mechanism for applying the memberIds intersection.

## Findings

### R3-F1 [major]

The plan states resolvePersonByName gains tenant scope 'via fetchPersonById (:680)' and 'so resolvePersonByName', but resolvePersonByName does NOT call fetchPersonById or fetchPeople. It performs its own direct `.or('display_name.ilike...,full_name.ilike...,handle.ilike...,vitana_id.ilike...')` query on `profiles` with `.limit(5)` (:655-659) and then calls `mapPerson(best)` directly. The (M) mechanism (`.in('user_id', memberIds)` added before ordering/limit) must therefore be applied to resolvePersonByName's OWN `.or()` query, not inherited through a non-existent call chain. As written, with the flag on, resolvePersonByName would still perform a network-wide fuzzy name search and return cross-tenant members — the exact tenant-isolation leak R1-F2 flagged in round 1, still unresolved in its mechanism.

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:649` — export async function resolvePersonByName(hint: string): Promise<SocialPerson | null> { ... .from('profiles').select(`${PROFILE_COLS}, full_name`).or(`display_name.ilike.%${term}%,full_name.ilike.%${term}%,handle.ilike.%${term}%,vitana_id.ilike.%${term}%`).limit(5); ... return mapPerson(best); }
- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:678` — export async function fetchPersonById(personId: string) { const people = await fetchPeople([personId]); return people.get(personId) ?? null; }

Suggestion: Correct the mechanism: resolvePersonByName must add `.in('user_id', memberIds)` (or an equivalent active-tenant membership predicate) directly to its own `.or()` query at :655 BEFORE the `.limit(5)`, so the top-5 name search is not starved by hydration-time filtering. Remove the inaccurate claim that resolvePersonByName inherits scope via fetchPersonById, and add a Vitest assertion that resolvePersonByName returns only active-tenant members with the flag on.

### R3-F2 [minor]

The (M) mechanism enumerates columns to filter as `user_id | to_user_id | followee_id | following_id | follower_id`, but `fetchMatches` reads `user_matches` via a two-column `.or('user_id_1.eq.${userId},user_id_2.eq.${userId}')` (:187). The plan maps 'user_matches → (M)' without specifying how the memberIds intersection applies to a two-column OR (neither `user_id_1` nor `user_id_2` appears in the enumeration). An implementer would have to invent `.or('user_id_1.in.(memberIds),user_id_2.in.(memberIds)')` — unspecified and easy to get wrong (dropping the mutual-match whose counterpart is in-tenant but the viewer's own column matches).

- `exafyltd/vitana-platform:services/gateway/src/services/social-memory/social-memory-repository.ts:184` — supabase.from('user_matches').select('user_id_1, user_id_2, compatibility_score, ...').or(`user_id_1.eq.${userId},user_id_2.eq.${userId}`).order('matched_at', { ascending: false }).limit(limit)

Suggestion: Add `user_id_1` / `user_id_2` to the (M) column enumeration and specify the predicate for the mutual-match table (e.g. filter each row so that the OTHER party is in memberIds, or `.or('user_id_1.in.(memberIds),user_id_2.in.(memberIds)')`), with a Vitest case confirming a cross-tenant counterpart is not surfaced.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Fix (f) enumerates the four daily_matches readers as (C) .eq('tenant_id', tenantId); verified the handlers hold ctx.tenantId (connect-people.ts:61,108) and the reader signatures at connect-people-repository.ts:77-107. Correctly reclassified from the generic (M) mapping.
- R2-F2: acknowledged — Fix (e) defines fetchPeople(userIds, scope?) with an explicit memberIds intersection and enumerates internal callers (fetchFollowEdges :151, fetchMatches :231, fetchPersonById :680) plus chat-derived hydrations (:287,:354) left unscoped; verified those call sites match the code.
