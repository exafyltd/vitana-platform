#!/bin/bash
# VTID: DEV-CICDL-0051
# GitHub Hygiene & Branch Governance

echo "=== GitHub Cleanup Report ==="
echo ""

# 1. List all remote branches
echo "Remote Branches:"
git branch -r | grep -v "HEAD"

echo ""
echo "=== PR Analysis ==="

# 2. Check open PRs
gh pr list --limit 50 --json number,title,headRefName,createdAt,state,isDraft

echo ""
echo "=== Cleanup Actions ==="

# PRs to evaluate:
# #30 - DEV-CICDL-0041 (15h old) - Keep if active
# #29 - DEV-AICOR-0026 (1d old, AutoLogger observability) - MERGE or CLOSE
# #28 - DEV-CICDL-0040 (2d old, AutoLogger main) - CLOSE (superseded by #29)
# #26 - docs/phase1-bootstrap (4d old) - Review and merge/close
# #21 - devhub-sse-feed (9d old) - Probably stale, close
# #18 - test-ci-final (9d old) - Stale, close

echo "Recommended Actions:"
echo ""
echo "MERGE:"
echo "  #29 - AutoLogger observability (adds health endpoint we need)"
echo ""
echo "CLOSE (superseded/stale):"
echo "  #28 - Old AutoLogger implementation (different approach)"
echo "  #21 - DevHub SSE (9 days old, likely superseded)"
echo "  #18 - test-ci-final (9 days old, test branch)"
echo ""
echo "REVIEW:"
echo "  #30 - DEV-CICDL-0041 (recent, may be active)"
echo "  #26 - Phase 1 docs (may be valuable)"
