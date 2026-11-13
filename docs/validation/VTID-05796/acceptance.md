# Acceptance: VTID allocation routine documentation

VTID-05796, allocated by the VTID-ALLOCATE workflow (run 43433860852, VTID_RESULT=VTID-05796).

AC-1: The routine names the VTID-ALLOCATE workflow and the REST dispatch command.
TEST: grep -q "VTID-ALLOCATE.yml/dispatches" docs/VTID-ALLOCATION.md (run in this PR; output in outputs/grep.txt)

AC-2: The routine says a session never asks for a token to allocate.
TEST: grep -q "never asks for a token" docs/VTID-ALLOCATION.md (run in this PR; output in outputs/grep.txt)

AC-3: The routine lists the five body declarations the validator checks.
TEST: grep -q "OASIS_IMPACT" docs/VTID-ALLOCATION.md (run in this PR; output in outputs/grep.txt)
