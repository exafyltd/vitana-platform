#!/usr/bin/env node
/**
 * VTID-113: Add safe Supabase initialization to governanceController.ts
 * 
 * This script replaces the top-level `createClient` call with `getSupabase()`
 * imports and injects null safety checks into each controller method.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/controllers/governanceController.ts');

console.log(`[VTID-113] Reading ${filePath}...`);
let content = fs.readFileSync(filePath, 'utf8');

// Step 1: Replace imports
console.log('[VTID-113] Step 1: Replacing imports...');
content = content.replace(
    `import { createClient } from '@supabase/supabase-js';`,
    `import { getSupabase } from '../lib/supabase';`
);

// Step 2: Remove module-level Supabase client creation
console.log('[VTID-113] Step 2: Removing module-level client creation...');
const moduleLoadPattern = /const supabaseUrl = process\.env\.SUPABASE_URL \|\| '';[\r\n]+const supabaseKey = process\.env\.SUPABASE_SERVICE_ROLE_KEY \|\| '';[\r\n]+const supabase = createClient\(supabaseUrl, supabaseKey\);[\r\n]+/;
content = content.replace(moduleLoadPattern, `// Removed unsafe module-load createClient - now using getSupabase() in methods\n`);

// Step 3: Add null check helper at the start of each method
console.log('[VTID-113] Step 3: Adding null checks to methods...');

const methods = [
    { name: 'getCategories', afterLine: 'const tenantId = this.getTenantId(req);', operation: 'categories fetch' },
    { name: 'getRules', afterLine: 'const { category, status, ruleCode } = req.query;', operation: 'rules fetch' },
    { name: 'getRuleByCode', afterLine: 'const { ruleCode } = req.params;', operation: 'rule fetch' },
    { name: 'getProposals', afterLine: 'const { status, ruleCode, limit, offset } = req.query;', operation: 'proposals fetch' },
    { name: 'createProposal', afterLine: 'const { type, ruleCode, proposedRule, rationale, source } = req.body;', operation: 'proposal creation' },
    { name: 'updateProposalStatus', afterLine: 'const { proposalId } = req.params;', operation: 'proposal status update' },
    { name: 'getEvaluations', afterLine: 'const { ruleCode, result, from, to, limit, offset } = req.query;', operation: 'evaluations fetch' },
    { name: 'getViolations', afterLine: 'const tenantId = this.getTenantId(req);', operation: 'violations fetch', index: 2 }, // Second occurrence
    { name: 'getFeed', afterLine: '// Query oasis_events_v1 for governance-related events', operation: 'feed fetch' },
    { name: 'getEnforcements', afterLine: 'const tenantId = this.getTenantId(req);', operation: 'enforcements fetch', index: 3 }, // Third occurrence
    { name: 'getLogs', afterLine: '// Query canonical oasis_events table', operation: 'logs fetch' }
];

methods.forEach(({ name, afterLine, operation, index = 1 }) => {
    const nullCheck = `\n\n        const supabase = getSupabase();\n        if (!supabase) {\n            console.warn('[GovernanceController] Supabase not configured - ${operation} unavailable');\n            return res.status(503).json({\n                ok: false,\n                error: 'SUPABASE_CONFIG_ERROR',\n                message: 'Governance storage is temporarily unavailable'\n            });\n        }`;

    let count = 0;
    content = content.replace(new RegExp(afterLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match, offset) => {
        count++;
        if (count === index) {
            return match + nullCheck;
        }
        return match;
    });

    console.log(`[VTID-113]   ✓ Added null check to ${name}`);
});

// Step 4: Fix emitOasisEvent helper (private method, no res object)
console.log('[VTID-113] Step 4: Fixing emitOasisEvent helper...');
const emitOasisPattern = /private async emitOasisEvent\(tenant: string, eventType: string, data: any\) \{[\r\n]+\s+try \{[\r\n]+\s+await supabase\.from/;
const emitOasisReplacement = `private async emitOasisEvent(tenant: string, eventType: string, data: any) {
        try {
            const supabase = getSupabase();
            if (!supabase) {
                console.warn('[GovernanceController] Supabase not configured - OASIS event not persisted');
                return;
            }
            
            await supabase.from`;

content = content.replace(emitOasisPattern, emitOasisReplacement);

// Write the modified file
console.log(`[VTID-113] Writing changes back to ${filePath}...`);
fs.writeFileSync(filePath, content, 'utf8');

console.log('[VTID-113] ✓ Successfully applied safe Supabase initialization pattern!');
console.log('[VTID-113] Next steps:');
console.log('[VTID-113]   1. Run: npm run build');
console.log('[VTID-113]   2. Test with missing env vars');
console.log('[VTID-113]   3. Verify 503 responses');
