# VTID-04951 — acceptance

Guide mode: "Ask Vitana" on a screen opens Vitana as that screen's FAQ / how-to guide.
Companion frontend change: exafyltd/vitana-v1#1263.

AC-1 The session-start fields are validated one by one: a malformed feature or state drops the whole guide, kind/title are dropped when they fail, an injection-shaped title is flattened (no line breaks, no quotes, max 80).
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (sanitizeGuideContext)

AC-2 The guide opens turn 1 only; a later reconnect never re-opens it.
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (guideOpenFrom)

AC-3 The guide_open rung wins on both greeting ladders with the precedence support_report > guide_open > guided_topic > resume_thread, never for an anonymous session, never on a work surface.
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (guide_open rung)

AC-4 The opener is an English intent with no quoted sentence (NEVER-rule 41) and the system instruction carries a GUIDE MODE block for the whole conversation, with the knowledge-base fallback and the injection guard.
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (the opener and the instruction block)

AC-5 A guide session never claims a pooled prewarmed Nova stream.
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (wiring), services/gateway/test/orb/live/prewarm/vtid-04554-prewarm-parity.test.ts

AC-6 The widget exposes VitanaOrb.startGuide and sends the four fields one-shot; the cache-bust is bumped and every suite that names it follows.
TEST: services/gateway/test/orb/live/guide/vtid-04951-guide-mode.test.ts (wiring), services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts

AC-7 The Command Hub ownership guard admits this VTID (orb-widget.js + index.html only).
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts

OASIS_PROOF: not applicable — OASIS_IMPACT is no (no new event, no state transition).
