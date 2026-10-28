# Sparring round 2 — converged

Session: `789653a6-dff1-4e28-960c-6e34ad0506a7` · plan hash `55960ff32dcd0bbd53e6e8bcd1cc594d14d3e43ee6525314d7d7ac332338095e`

## Summary

Round 2 review of the memory-diary wave 2 plan. All three R1 findings were accepted and the revised plan addresses each one substantively. I verified the key premises against the pinned code: the 7 ledger rows match exactly, parity-scope.json lane rules are correct, MobileDailyDiary.tsx uses MobileAppShell, all four memory/diary API modules import communityFetch, the /memory/diary redirect is confirmed, and the core createGatewayFetch does not inject X-Vitana-Active-Role (confirming the wrapper is needed). One new minor finding regarding the communityFetch Content-Type auto-set behavior that the native wrapper and test should cover for diary writes.

## Findings

### R2-F1 [minor]

The plan's R1-F3 fix specifies the native community-gateway wrapper must send X-Vitana-Active-Role: community and the test must assert that header plus the Bearer token. However, the web communityFetch (community-gateway.ts:18-20) also auto-sets Content-Type: application/json when the request body is a string. The core createGatewayFetch (packages/core/src/gateway.ts:25-31) does NOT add this header — it only merges headers from init. The diary lane performs POST writes (diary-index-sync.ts → POST /api/v1/memory/diary/sync-index with a JSON string body). If the native wrapper omits this Content-Type auto-set, the gateway may reject or misparse diary-write bodies. The plan says 'and any other community-gateway headers' which is correct in spirit but the test plan only names two headers (active-role + Bearer), not Content-Type for write calls.

- `exafyltd/vitana-v1:src/lib/community-gateway.ts:18` — if (options?.body && typeof options.body === "string") {
      headers["Content-Type"] = "application/json";
    }
- `exafyltd/vitana-v1:packages/core/src/gateway.ts:25` — const headers: Record<string, string> = {};
      new Headers(init.headers ?? undefined).forEach((value, key) => {
        headers[key] = value;
      });
      const token = await getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
      return fetchImpl(`${api}${rel}`, { ...init, headers });
- `exafyltd/vitana-v1:src/lib/diary-index-sync.ts:5` — the gateway's POST /api/v1/memory/diary/sync-index endpoint.

Suggestion: Add to the wrapper spec that it must replicate the Content-Type: application/json auto-set for string bodies (matching communityFetch:18-20), and add a fake-gateway test case for a diary-write (POST) call asserting Content-Type: application/json is present alongside X-Vitana-Active-Role: community.
