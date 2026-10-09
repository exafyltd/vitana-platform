# VTID-05004 — acceptance

- AC-1 Linked key: the "Your Kiro API key" row reads "✓ Connected" in green; no Replace/Revoke buttons; one "Manage key".
- AC-2 Manage key reveals exactly Replace, Revoke, Done; Done hides them again.
- AC-3 Revoke still asks first; a failed revoke keeps the manage view.
- AC-4 Not linked / Replace flows unchanged.
- AC-5 No overflow at 1400x900 and 390x844 (outputs/kiro-key-*.png).

OASIS_IMPACT: no (front-end only; no new events).
