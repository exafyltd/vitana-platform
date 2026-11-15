# Sparring round 1 — in_progress

Session: `0326080a-8433-4b5a-b0ce-02c2bf5e80e5` · plan hash `ac96be89c0fad9221985d731a7621c37e39fa882bbbc2c1f1d0b23da53cef21c`

## Summary

The plan correctly identifies the token-in-path leakage gap and proposes a sound fix in `prepare()` and at the top of `paginate()`. The premises about regex flags, `serializeQuery` scope, `redact` coverage, and the mutation harness bug are all verified. However, the plan misses one pre-`prepare()` error path in `request()` that would leak a token-bearing path in the error's `.path` property.

## Findings

### R1-F1 [major]

The plan adds the token-path check to `prepare()` and to the top of `paginate()` (before `checkNumber`), but misses `request()` (line 375-378). `request()` throws `badRequest(…, method, path)` when `opts.okStatuses !== undefined` BEFORE calling `raw()` → `prepare()`. The `badRequest` helper (line 98) stores `path` in the error object, and `toJSON()` (line 74-76) serialises it. If a caller passes a token-bearing path AND `okStatuses` to `request()` (or any shortcut: `get`, `post`, `put`, `patch`, `del`), the error leaks the token through `.path` and `JSON.stringify(err)`. The plan's stated goal is to ensure the token never appears in any error; this path bypasses the proposed defence.

- `exafyltd/vitana-platform:scripts/eng/gitlab-api.mjs:374` — async function request(method, path, opts = {}) {
    if (opts.okStatuses !== undefined) {
      throw badRequest('request() does not take okStatuses (a non-2xx answer is an error); use raw() to accept a status', String(method).toUpperCase(), path);
    }
    return (await raw(method, path, opts)).data;
  }
- `exafyltd/vitana-platform:scripts/eng/gitlab-api.mjs:98` — const badRequest = (message, method, path) => new GitLabApiError(message, { code: 'bad_request', method, path });
- `exafyltd/vitana-platform:scripts/eng/gitlab-api.mjs:73` — toJSON() {
    const { name, message, code, status, method, path, attempts, networkCode, responseStatus, retryAfterMs } = this;
    return {
      name, message, code, status, method, path, attempts,
      ...(networkCode ? { networkCode } : {}), ...(responseStatus !== undefined ? { responseStatus } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }

Suggestion: Add the same token-path refusal at the top of `request()` before the `okStatuses` check, or extract the check into a shared helper that `prepare()`, `paginate()`, and `request()` all call before any `badRequest` that includes `path`. Also add a test: `client.request('GET', '/path-with-' + TOKEN, { okStatuses: [404] })` must reject with `code: 'bad_path'` and the error must contain no part of the token.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
