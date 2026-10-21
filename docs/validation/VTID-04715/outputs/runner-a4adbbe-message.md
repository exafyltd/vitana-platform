**Staging verification superseded** — staging moved past `a4adbbea580f` during the run; the newer deploy gets its own verification. No production prompt.

- Service: `gateway`
- Verified commit: `a4adbbea580f7389ce00529a675e9a5d59000a1e`
- Tests: 0/1 passed

Failed:
- deploy › production is behind the verified commit: production already runs bf6360e74c09, which contains a4adbbea580f — nothing to ship, and promoting a4adbbea580f would roll production back

What would ship (production `bf6360e74c09` → `a4adbbea580f`, 0 commit(s)):
- (none — production already serves or contains this commit, or its version could not be read)
