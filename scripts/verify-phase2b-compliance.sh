#!/bin/bash

# Phase 2B Naming & Governance Verification Script
# Run this before committing to ensure compliance with Phase 2B standards
#
# Usage: ./scripts/verify-phase2b-compliance.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

VIOLATIONS=0
WARNINGS=0

echo -e "${BLUE}🔍 Phase 2B Compliance Verification${NC}"
echo "=================================================="
echo ""

# Check 1: Workflow Naming
echo -e "${BLUE}[1/6] Checking GitHub Actions workflow naming...${NC}"
workflow_violations=0

for file in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$file" ] || continue
  
  filename=$(basename "$file")
  
  # Skip special files
  if [[ "$filename" == _* ]] || [[ "$filename" == "PHASE-2B-NAMING-ENFORCEMENT.yml" ]]; then
    continue
  fi
  
  # Check for lowercase
  basename_no_ext="${filename%.*}"
  if echo "$basename_no_ext" | grep -q '[a-z]'; then
    echo -e "${RED}  ❌ $file${NC}"
    echo "     Expected: UPPERCASE-WITH-HYPHENS.yml"
    workflow_violations=$((workflow_violations + 1))
  else
    echo -e "${GREEN}  ✅ $file${NC}"
  fi
done

if [ $workflow_violations -gt 0 ]; then
  echo -e "${RED}  Found $workflow_violations workflow naming violations${NC}"
  VIOLATIONS=$((VIOLATIONS + workflow_violations))
else
  echo -e "${GREEN}  ✅ All workflows use UPPERCASE naming${NC}"
fi
echo ""

# Check 2: Workflow run-name
echo -e "${BLUE}[2/6] Checking workflow run-names include VTID...${NC}"
runname_warnings=0

for file in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -f "$file" ] || continue
  
  filename=$(basename "$file")
  
  if [[ "$filename" == _* ]] || [[ "$filename" == "PHASE-2B-NAMING-ENFORCEMENT.yml" ]]; then
    continue
  fi
  
  if ! grep -q "^run-name:" "$file"; then
    echo -e "${YELLOW}  ⚠️  $file missing run-name${NC}"
    runname_warnings=$((runname_warnings + 1))
  elif ! grep -A 1 "^run-name:" "$file" | grep -qi "vtid\|github.ref"; then
    echo -e "${YELLOW}  ⚠️  $file run-name doesn't include VTID${NC}"
    runname_warnings=$((runname_warnings + 1))
  else
    echo -e "${GREEN}  ✅ $file${NC}"
  fi
done

if [ $runname_warnings -gt 0 ]; then
  echo -e "${YELLOW}  Found $runname_warnings workflows without VTID in run-name${NC}"
  echo "  📘 Add: run-name: 'Action Name [VTID: DEV-XXXX-NNNN]'"
  WARNINGS=$((WARNINGS + runname_warnings))
else
  echo -e "${GREEN}  ✅ All workflows have VTID in run-name${NC}"
fi
echo ""

# Check 3: File Naming (kebab-case)
echo -e "${BLUE}[3/6] Checking file naming convention (kebab-case)...${NC}"
file_violations=0

while IFS= read -r file; do
  filename=$(basename "$file")
  
  # Skip node_modules, .git, etc
  if echo "$file" | grep -qE "node_modules|\.git|\.next|dist|build"; then
    continue
  fi
  
  basename_no_ext="${filename%.*}"
  
  # Check for camelCase or snake_case
  if echo "$basename_no_ext" | grep -qE "[A-Z]|_"; then
    # Allow exceptions
    if [[ "$filename" =~ ^(README|LICENSE|CHANGELOG|Dockerfile|Makefile)\.? ]]; then
      continue
    fi
    
    echo -e "${RED}  ❌ $file${NC}"
    echo "     Expected: kebab-case (e.g., my-service.ts)"
    file_violations=$((file_violations + 1))
  fi
done < <(find . -type f \( -name "*.ts" -o -name "*.js" -o -name "*.tsx" -o -name "*.jsx" \) -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null || true)

if [ $file_violations -gt 0 ]; then
  echo -e "${RED}  Found $file_violations file naming violations${NC}"
  VIOLATIONS=$((VIOLATIONS + file_violations))
else
  echo -e "${GREEN}  ✅ All files use kebab-case naming${NC}"
fi
echo ""

# Check 4: VTID Constants
echo -e "${BLUE}[4/6] Checking VTID constant formatting...${NC}"
vtid_warnings=0

while IFS= read -r match; do
  echo -e "${YELLOW}  ⚠️  $match${NC}"
  echo "     Use: const VTID = '...' (UPPERCASE)"
  vtid_warnings=$((vtid_warnings + 1))
done < <(find services packages -type f \( -name "*.ts" -o -name "*.js" \) -exec grep -nH "^\s*const vtid\s*[:=]" {} \; 2>/dev/null || true)

if [ $vtid_warnings -gt 0 ]; then
  echo -e "${YELLOW}  Found $vtid_warnings VTID format warnings${NC}"
  WARNINGS=$((WARNINGS + vtid_warnings))
else
  echo -e "${GREEN}  ✅ All VTID constants use UPPERCASE${NC}"
fi
echo ""

# Check 5: Cloud Run Labels
echo -e "${BLUE}[5/6] Checking Cloud Run deployment scripts for labels...${NC}"
label_warnings=0

while IFS= read -r file; do
  if ! grep -q "vtid" "$file" || ! grep -q "vt_layer" "$file"; then
    echo -e "${YELLOW}  ⚠️  $file missing VTID labels${NC}"
    echo "     Add: --labels vtid=DEV-XXXX-NNNN,vt_layer=CICDL,vt_module=SERVICE"
    label_warnings=$((label_warnings + 1))
  else
    echo -e "${GREEN}  ✅ $file${NC}"
  fi
done < <(find . -name "deploy*.sh" -o -name "*deploy*.sh" 2>/dev/null || true)

if [ $label_warnings -gt 0 ]; then
  echo -e "${YELLOW}  Found $label_warnings deployment scripts without proper labels${NC}"
  WARNINGS=$((WARNINGS + label_warnings))
else
  echo -e "${GREEN}  ✅ All deployment scripts include VTID labels${NC}"
fi
echo ""

# Check 6: Phase 2B Documentation
echo -e "${BLUE}[6/6] Checking Phase 2B documentation files...${NC}"
doc_violations=0

for i in $(seq -w 00 20); do
  count=$(ls phase_2b/${i}_*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    echo -e "${RED}  ❌ Missing: phase_2b/${i}_*.md${NC}"
    doc_violations=$((doc_violations + 1))
  fi
done

if [ $doc_violations -gt 0 ]; then
  echo -e "${RED}  Found $doc_violations missing Phase 2B documentation files${NC}"
  VIOLATIONS=$((VIOLATIONS + doc_violations))
else
  echo -e "${GREEN}  ✅ All Phase 2B documentation files present${NC}"
fi
echo ""

# Summary
echo "=================================================="
if [ $VIOLATIONS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}✅ PHASE 2B COMPLIANCE: PASS${NC}"
  echo -e "${GREEN}All checks passed! Ready to commit.${NC}"
  exit 0
elif [ $VIOLATIONS -eq 0 ]; then
  echo -e "${YELLOW}⚠️  PHASE 2B COMPLIANCE: PASS WITH WARNINGS${NC}"
  echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
  echo "You can proceed, but consider fixing warnings."
  exit 0
else
  echo -e "${RED}❌ PHASE 2B COMPLIANCE: FAIL${NC}"
  echo -e "${RED}Violations: $VIOLATIONS${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
  fi
  echo ""
  echo "Please fix the violations above before committing."
  exit 1
fi
