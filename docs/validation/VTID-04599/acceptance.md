# VTID-04599 — "jetzt ist Schluss" / "ok, Schluss" closes the conversation even if Vitana refuses

This is a follow-up to VTID-04592, which fixed production session live-6786b50c (00:39 Berlin, 2026-09-26). That fix is in production (`ea0ccbf`). "geh jetzt", "schalte ab" and a bare "Schluss" now close the conversation on their own, even when Vitana refuses.

Checked against a refusal reply, one gap remained: "Schluss" with filler words around it ("jetzt ist Schluss", "ok, Schluss", "Schluss für heute") still needed Vitana to agree before closing. This change makes it unambiguous as well. "Schluss" that carries content ("zum Schluss noch eine Frage", "mach Schluss mit dem Thema", "ich habe Schluss gemacht") is still not treated as a stop request on its own.

AC-1: "Schluss" with only filler words closes the conversation even when Vitana refuses; the VTID-04592 phrases still close.
TEST: services/gateway/test/orb/live/session/vtid-04599-schluss-with-filler.test.ts

AC-2: "Schluss" that carries content does not close on its own.
TEST: services/gateway/test/orb/live/session/vtid-04599-schluss-with-filler.test.ts

AC-3: The VTID-04592 suite is unchanged and green.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts
