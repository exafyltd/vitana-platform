# VTID-03250 — vitana-v1: send the browser timezone on ORB session start

**Status:** patch (vitana-v1 is a separate repo; can't deploy from the gateway sandbox). **This is the piece that fixes mobile**, where most testers are.

## Why
The ORB ENVIRONMENT context (location + **local time** the assistant speaks) was derived only from **geo-IP**, which rate-limits (ipapi.co HTTP 429). When it fails, the gateway had no timezone → the assistant hallucinated the time ("8:30 PM" at 15:44) and city ("Berlin" in Cologne).

The gateway now **prefers a browser-supplied timezone** over geo-IP (VTID-03250, `buildClientContext` + `resolveSessionTimezone`). The browser knows its IANA zone reliably via `Intl` — so the client must send it.

## Change (vitana-v1 ORB widget, where it POSTs `/api/v1/orb/live/session/start`)
Add `client_timezone` to the start payload (mirrors the command-hub widget fix):

```js
const startPayload = { /* lang, voice_style, response_modalities, vad_silence_ms, ... */ };
try {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; // e.g. "Europe/Berlin"
  if (tz) startPayload.client_timezone = tz;
} catch (_e) { /* Intl unavailable — gateway falls back to geo-IP */ }
```

(Equivalently, send an `x-client-timezone` header — the gateway accepts either.)

## Acceptance
- On mobile, ask Vitana "what time is it?" / "where am I?" → she uses the device's real timezone for local time, even when geo-IP is rate-limited. City still comes from geo-IP (degrades gracefully — she won't fabricate a city when geo is unavailable; she just won't name one).

## Gateway side (already shipped, VTID-03250)
`buildClientContext` reads `body.client_timezone` / `x-client-timezone` and prefers it via `resolveSessionTimezone`. The context-integrity unit gate (`test/services/context-integrity.test.ts`) locks this so it can't silently regress.
