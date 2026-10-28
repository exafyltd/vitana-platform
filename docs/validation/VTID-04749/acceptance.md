# VTID-04749 — a correction was claimed, not stored

Production live-11ec418b (2026-09-29).
- The member asked Vitana to correct the company name to Exify, seated in Abu Dhabi.
- Vitana said "ich korrigiere … heißt jetzt Exify", called no tool, and "Exafile Limited" stayed stored.
- Correction words were neither remember requests nor save claims, so the backstop never ran.

Fix: korrigier / änder (with a name or entry nearby) / aktualisier / update / correct are now remember requests. "ich korrigiere/ändere/aktualisiere", "habe … korrigiert/geändert/aktualisiert" and "I've updated/corrected/changed" are now save claims.

The backstop then extracts the new value. When it conflicts with a stored one, Vitana names both and asks which is right, per the B-CONF contract.

## Acceptance

AC-1: correction requests and claims are recognised. Questions and negations are not.
TEST: services/gateway/test/services/memory/vtid-04749-correction-backstop.test.ts
