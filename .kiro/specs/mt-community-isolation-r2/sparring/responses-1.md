# Responses to round 1

```json
[
{"finding_id":"R1-F1","disposition":"accepted","rationale":"Verified: social-memory-repository.ts:652 strips only % and _, and :658 interpolates the term into .or(). plan.md fix (e) and tasks.md G2a now make the stripping of ,()*:.\"\\ unconditional (flag off and on); only the .in('user_id', memberIds) tenant predicate is behind feature_flags.mt.community_scope. The test asserts no extra clause with the flag off and on.","deferred_to":""},
{"finding_id":"R1-F2","disposition":"accepted","rationale":"Verified: resolveAuthorPost (p0-gap-tools.ts:483) calls resolveMember at :488 and is called only by tool_like_post (:502, call :512) and tool_comment_on_post (:542, call :555); grep finds no other caller of resolveMember or resolveAuthorPost. plan.md fix (e) and tasks.md G2 now add an id parameter to resolveAuthorPost, threaded from both tools, plus a test that the tenant reaches resolvePersonByName. File is already in the lane's paths; no lane file change.","deferred_to":""},
{"finding_id":"R1-F3","disposition":"accepted","rationale":"Verified: interface BuildPersonContextInput starts at person-context-builder.ts:35 with tenant_id at :36. Reference corrected to :36 in plan.md.","deferred_to":""},
{"finding_id":"R1-F4","disposition":"accepted","rationale":"Verified: grep -n shows p_global: false at users-resolve-repository.ts:27. Both references in plan.md corrected to :27.","deferred_to":""}
]
```
