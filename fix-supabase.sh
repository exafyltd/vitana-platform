#!/bin/bash
# Simple script to replace supabase imports

file="src/controllers/governanceController.ts"

# Remove old import and top-level client
sed -i '2,8d' "$file"

# Add new import
sed -i '1a import { getSupabase } from '"'"'../lib/supabase'"'"';\nimport { RuleMatcher, EvaluationEngine, EnforcementExecutor, ViolationGenerator, OasisPipeline } from '"'"'../validator-core'"'"';\nimport { RuleDTO, EvaluationDTO, ViolationDTO, ProposalDTO, FeedEntry, EvaluationSummary, ProposalTimelineEvent } from '"'"'../types/governance'"'"';' "$file"

# Add getSupabase() to all try blocks
sed -i '/try {$/a \ \ \ \ \ \ \ \ \ \ \ \ const supabase = getSupabase();' "$file"

echo "Done"
