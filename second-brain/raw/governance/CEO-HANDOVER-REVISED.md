# CEO Handover – Canonical Frontend Source
# GOV-FRONTEND-CANONICAL-SOURCE-0001

## What this rule enforces
- Only one valid source tree for the Command Hub
- No accidental shadow directories
- Build output locked to dist/frontend/command-hub
- CI and Validator block violations

## What Claude must do
1. Install all 7 artifacts
2. Commit and push with VTID
3. Execute SQL governance rule
4. Run structure verification
5. Report successful enforcement

## Zero-touch principle
Claude MUST NOT:
- Delete source directories
- Modify build process
- Change Express routing
- Touch any frontend files

This is governance-only.
