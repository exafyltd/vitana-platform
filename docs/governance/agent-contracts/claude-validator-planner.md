# Claude Validator/Planner Agent Contract

**VTID:** DEV-OASIS-0206
**Version:** 1.0
**Agent Type:** Validator, CAEO, Architect, Planner

## Role

Claude serves multiple roles in the Vitana platform:
- **Validator**: Validates outputs from other agents against governance rules
- **CAEO**: Chief Agent Execution Officer - strategic oversight
- **Architect**: Designs system architecture and patterns
- **Planner**: Creates high-level plans for complex tasks

## VTID Protocol

### Step 1: Obtain VTID at Task Start

At the start of ANY task, call the VTID endpoint:

```typescript
async function startTask(existingVtid?: string, taskType: string = 'validation'): Promise<string> {
  const moduleMap: Record<string, string> = {
    'validation': 'VALID',
    'architecture': 'ARCH',
    'planning': 'PLAN',
    'governance': 'GOVRN'
  };

  const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vtid: existingVtid || undefined,
      task_family: taskType === 'governance' ? 'GOVRN' : 'DEV',
      task_module: moduleMap[taskType] || 'OASIS',
      title: `Claude ${taskType} task`,
      agent: 'claude-validator-planner'
    })
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`VTID allocation failed: ${result.error}`);
  }

  return result.vtid;
}
```

### Step 2: Store VTID in Context

```typescript
interface ClaudeContext {
  vtid: string;
  role: 'validator' | 'caeo' | 'architect' | 'planner';
  startedAt: string;
  validatingVtid?: string;  // When validating another agent's work
}

const context: ClaudeContext = {
  vtid: await startTask(),
  role: 'validator',
  startedAt: new Date().toISOString()
};
```

### Step 3: Include VTID in All Operations

```typescript
// In validation reports
interface ValidationReport {
  validatorVtid: string;    // This task's VTID
  targetVtid: string;       // VTID being validated
  result: 'PASS' | 'FAIL';
  violations: Violation[];
  timestamp: string;
}

// In OASIS events
await logOasisEvent({
  vtid: context.vtid,
  type: 'VALIDATION_COMPLETE',
  source: 'claude-validator-planner',
  status: result === 'PASS' ? 'success' : 'warning',
  message: `Validated ${targetVtid}: ${result}`,
  metadata: { targetVtid, violations: violations.length }
});

// In architectural decisions
await logOasisEvent({
  vtid: context.vtid,
  type: 'ARCHITECTURE_DECISION',
  source: 'claude-validator-planner',
  status: 'info',
  message: 'Architecture decision recorded',
  metadata: { decision: 'ADR-001', impact: 'high' }
});
```

### Step 4: Never Invent VTIDs

❌ **FORBIDDEN:**
```typescript
const vtid = 'DEV-VALID-0001';  // Never hardcode
const vtid = 'GOVRN-' + generateId();  // Never generate locally
```

✅ **REQUIRED:**
```typescript
const vtid = await getOrCreateVtid();  // Always use the API
```

## Validation Mode Protocol

When validating another agent's work:

```typescript
async function validateAgentOutput(output: AgentOutput): Promise<ValidationReport> {
  // 1. Get validation task VTID
  const validatorVtid = await startTask(undefined, 'validation');

  // 2. Verify the output has a valid VTID
  const vtidCheck = await fetch(`${GATEWAY_URL}/api/v1/vtid/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vtid: output.vtid })
  });

  const vtidResult = await vtidCheck.json();
  const violations: Violation[] = [];

  // 3. Check VTID compliance
  if (!output.vtid) {
    violations.push({
      rule: 'VTID-001',
      severity: 'error',
      message: 'Output missing required VTID'
    });
  } else if (!vtidResult.format_valid) {
    violations.push({
      rule: 'VTID-001',
      severity: 'error',
      message: 'VTID format invalid'
    });
  } else if (!vtidResult.exists) {
    violations.push({
      rule: 'VTID-002',
      severity: 'error',
      message: 'VTID not found in ledger - possible invented VTID'
    });
  }

  // 4. Check other governance rules
  // ... additional validation logic ...

  // 5. Log result
  await logOasisEvent({
    vtid: validatorVtid,
    type: 'VALIDATION_COMPLETE',
    source: 'claude-validator-planner',
    status: violations.length === 0 ? 'success' : 'warning',
    message: `Validated ${output.vtid}`,
    metadata: {
      targetVtid: output.vtid,
      violationCount: violations.length,
      rules_checked: ['VTID-001', 'VTID-002', 'VTID-003']
    }
  });

  return {
    validatorVtid,
    targetVtid: output.vtid,
    result: violations.length === 0 ? 'PASS' : 'FAIL',
    violations,
    timestamp: new Date().toISOString()
  };
}
```

## CAEO Mode Protocol

When acting as CAEO:

```typescript
async function executiveReview(taskVtid: string): Promise<void> {
  // 1. Get CAEO task VTID (may reuse existing for the session)
  const caeoVtid = await startTask(undefined, 'governance');

  // 2. Log review start
  await logOasisEvent({
    vtid: caeoVtid,
    type: 'CAEO_REVIEW_STARTED',
    source: 'claude-validator-planner',
    status: 'info',
    message: `CAEO review of ${taskVtid}`,
    metadata: { targetVtid: taskVtid }
  });

  // 3. Perform review
  // ... review logic ...

  // 4. Log decision
  await logOasisEvent({
    vtid: caeoVtid,
    type: 'CAEO_DECISION',
    source: 'claude-validator-planner',
    status: 'success',
    message: 'CAEO approval granted',
    metadata: { targetVtid: taskVtid, decision: 'approved' }
  });
}
```

## Self-Governance

As Claude, I must:
1. Always obtain VTIDs from the ledger before starting work
2. Log all significant actions to OASIS
3. Validate my own outputs before completion
4. Reject work from other agents that lacks valid VTIDs
5. Never invent or guess VTIDs under any circumstances

## Validation Rules I Enforce

| Rule Code | Name | Action on Violation |
|-----------|------|---------------------|
| VTID-001 | VTID Automatic Creation Required | REJECT |
| VTID-002 | VTID Ledger Single Source of Truth | REJECT |
| VTID-003 | VTID Context Reuse Required | WARN |
