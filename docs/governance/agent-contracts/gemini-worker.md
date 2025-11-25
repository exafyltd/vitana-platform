# Gemini Worker Agent Contract

**VTID:** DEV-OASIS-0206
**Version:** 1.0
**Agent Type:** Worker/Executor

## Role

The Gemini Worker agent executes implementation tasks assigned by the Planner. It writes code, runs tests, and deploys changes.

## VTID Protocol

### Step 1: Obtain VTID at Task Start

At the start of ANY task, call the VTID endpoint:

```typescript
// TypeScript example
async function startTask(existingVtid?: string): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vtid: existingVtid || undefined,  // Reuse if provided
      task_family: 'DEV',
      task_module: 'IMPL',
      title: 'Gemini Worker Implementation Task',
      agent: 'gemini-worker'
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
interface TaskContext {
  vtid: string;
  startedAt: string;
  agent: string;
}

const context: TaskContext = {
  vtid: await startTask(),
  startedAt: new Date().toISOString(),
  agent: 'gemini-worker'
};
```

### Step 3: Include VTID in All Operations

Every operation must reference the VTID:

```typescript
// In OASIS event logging
await logOasisEvent({
  vtid: context.vtid,
  type: 'TASK_PROGRESS',
  source: 'gemini-worker',
  status: 'info',
  message: 'Starting implementation phase'
});

// In commit messages
git commit -m "[${context.vtid}] Implement feature X"

// In final report
return {
  vtid: context.vtid,
  status: 'complete',
  artifacts: [...]
};
```

### Step 4: Never Invent VTIDs

❌ **FORBIDDEN:**
```typescript
const vtid = 'DEV-IMPL-0001';  // Never hardcode
const vtid = `DEV-IMPL-${counter++}`;  // Never generate manually
```

✅ **REQUIRED:**
```typescript
const vtid = await getOrCreateVtid();  // Always use the API
```

## Error Handling

If VTID allocation fails:
1. Log the error to OASIS (with a temporary ID)
2. Notify the Planner
3. Do NOT proceed with the task

```typescript
try {
  const vtid = await startTask();
} catch (error) {
  await logOasisEvent({
    vtid: 'DEV-ERROR-TEMP',
    type: 'VTID_ALLOCATION_FAILED',
    source: 'gemini-worker',
    status: 'error',
    message: error.message
  });
  throw error;
}
```

## Validation

All outputs will be validated by the Validator against:
- `VTID-001`: VTID must be present
- `VTID-002`: VTID must exist in ledger
- `VTID-003`: VTID must match task context
