VTID-113: Manual Fix Guide for governanceController.ts
=========================================================

Since automated tools are having difficulties with this large file,
here's a manual step-by-step guide to apply the VTID-112 pattern:

## Step 1: Replace Import (Lines 1-2)
FIND:
```
import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
```

REPLACE WITH:
```
import { Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
```

## Step 2: Remove Module-Load Client (Lines 6-8)  
FIND:
```
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// This will crash if env vars are missing
const supabase = createClient(supabaseUrl, supabaseKey);
```

REPLACE WITH:
```
// Removed unsafe module-load createClient - now using getSupabase() in methods
```

## Step 3: Add Null Checks to Each Method

For EACH of the following 11 methods, add this code block right after the method signature's opening brace and first variable declarations:

```typescript
        const supabase = getSupabase();
        if (!supabase) {
            console.warn('[GovernanceController] Supabase not configured - [operation] unavailable');
            return res.status(503).json({
                ok: false,
                error: 'SUPABASE_CONFIG_ERROR',
                message: 'Governance storage is temporarily unavailable'
            });
        }
```

### Method List:
1. `getCategories` - after line ~29 (`const tenantId = this.getTenantId(req);`)
2. `getRules` - after line ~64 (`const { category, status, ruleCode } = req.query;`)
3. `getRuleByCode` - after line ~157 (`const { ruleCode } = req.params;`)
4. `getProposals` - after line ~236 (`const { status, ruleCode, limit, offset } = req.query;`)
5. `createProposal` - after line ~292 (`const { type, ruleCode, proposedRule, rationale, source } = req.body;`)
6. `updateProposalStatus` - after line ~397 (`const { status } = req.body;`)
7. `getEvaluations` - after line ~500 (`const { ruleCode, result, from, to, limit, offset } = req.query;`)
8. `getViolations` - after line ~567 (`const tenantId = this.getTenantId(req);`) 
9. `getFeed` - after line ~621 (after comment `// Query oasis_events_v1...`)
10. `getEnforcements` - after line ~668 (`const tenantId = this.getTenantId(req);`)
11. `getLogs` - after line ~681 (after comment `// Query canonical oasis_events table`)

## Step 4: Fix emitOasisEvent Helper (~line 697)

FIND:
```typescript
    private async emitOasisEvent(tenant: string, eventType: string, data: any) {
        try {
            await supabase.from('oasis_events_v1').insert({
```

REPLACE WITH:
```typescript
    private async emitOasisEvent(tenant: string, eventType: string, data: any) {
        try {
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - OASIS event not persisted');
                return;
            }
            
            await supabase.from('oasis_events_v1').insert({
```

## Alternative: Use multi_replace_file_content

Make 13 separate replacement chunks (one for the import, one for module-load, 11 for methods, one for helper).

Each chunk should have precise StartLine, EndLine, TargetContent, and ReplacementContent.
