# Sparring round 1 — in_progress

Session: `6ecddfb3-fdbc-44f6-a7af-1038ad8bb9df` · plan hash `25c0d9c6fb1f7e1074819d76c7622f3d58671438ab439917e0259c20e543f1fe`

## Summary

Verified 8 distinct premises against the pinned code. All held. One major finding: the plan identifies and proposes to close the `system_prompt_override` wholesale overwrite at `ai-personality-service.ts:687` but does not address the equally powerful `Object.assign(merged, tenantConfig.extra_config)` at `:699-701`, which can overwrite any key on the merged config — including any new field the plan introduces (e.g. `pack_facts`). The plan's stated test ("the FIXED block survives a tenant override") must also cover this second override channel.

## Findings

### R1-F1 [major]

The plan identifies and closes the `system_prompt_override` → `base_identity` wholesale overwrite at `ai-personality-service.ts:687` but does not mention the unrestricted `Object.assign(merged, tenantConfig.extra_config)` at `:699-701`. This second override channel can set ANY key on the merged effective-config object, including a new `pack_facts` field. While the FIXED Vitana block is assembled from code and is therefore safe, the TENANT block reads `pack_facts` from the effective config (`getEffectiveConfigSync('voice_live', tenantId).pack_facts`). A `tenant_assistant_config.extra_config` row containing `{ "pack_facts": ... }` would silently overwrite the tenant's legitimate pack facts with arbitrary content. The plan's Problem §2 calls out only `:687`; the Risks section says "Mitigation: the split assembles the fixed block from code outside the override path" but says nothing about protecting the TENANT facts from `extra_config`. The test assertion should explicitly cover `extra_config` containing a `pack_facts` key and confirm the builder either rejects it or prefers the authoritative source.

- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:697` — if (tenantConfig.extra_config && typeof tenantConfig.extra_config === 'object') {
  Object.assign(merged, tenantConfig.extra_config);
}
merged._tenant_customized = true;
- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:687` — if (tenantConfig.system_prompt_override) {
  merged.base_identity = tenantConfig.system_prompt_override;
}

Suggestion: Explicitly state in the plan that (a) the builder validates / re-sources `pack_facts` from the authoritative pack definition rather than trusting whatever `getEffectiveConfig` returns, OR (b) `prewarmEffectiveConfig` strips / ignores `extra_config`-sourced `pack_facts` before caching, and (c) the persona-pack test suite includes a case where `extra_config` contains `{ pack_facts: <bogus> }` and asserts the builder produces the correct tenant block anyway.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
