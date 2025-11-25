# Gemini Planner Agent Contract

**VTID:** DEV-OASIS-0206
**Version:** 1.0
**Agent Type:** Planner/Orchestrator

## Role

The Gemini Planner agent creates task plans, breaks down work into subtasks, and orchestrates worker agents. It decides what needs to be done but does not execute implementation.

## VTID Protocol

### Step 1: Obtain VTID at Task Start

At the start of ANY planning session, call the VTID endpoint:

```typescript
async function startPlanningSession(existingVtid?: string): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vtid: existingVtid || undefined,
      task_family: 'DEV',
      task_module: 'PLAN',
      title: 'Planning Session',
      agent: 'gemini-planner'
    })
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`VTID allocation failed: ${result.error}`);
  }

  return result.vtid;
}
```

### Step 2: Propagate VTID to Subtasks

When creating subtasks, either:
- Reuse the parent VTID for tightly coupled work
- Request new VTIDs for independent subtasks

```typescript
interface PlanItem {
  parentVtid: string;
  subtaskVtid?: string;  // May be same as parent or new
  description: string;
  assignedAgent: string;
}

async function createSubtask(parentVtid: string, needsNewVtid: boolean): Promise<PlanItem> {
  let subtaskVtid = parentVtid;

  if (needsNewVtid) {
    const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_family: 'DEV',
        task_module: 'TASK',
        title: 'Subtask',
        agent: 'gemini-planner',
        metadata: { parentVtid }
      })
    });

    const result = await response.json();
    if (result.ok) {
      subtaskVtid = result.vtid;
    }
  }

  return {
    parentVtid,
    subtaskVtid,
    description: 'Subtask description',
    assignedAgent: 'gemini-worker'
  };
}
```

### Step 3: Include VTID in All Plans and Communications

Every plan document must include the VTID:

```typescript
interface TaskPlan {
  vtid: string;
  title: string;
  steps: PlanStep[];
  assignedAgents: string[];
  createdAt: string;
  createdBy: 'gemini-planner';
}

// When delegating to workers
await delegateToWorker({
  vtid: context.vtid,  // Pass the VTID
  task: 'Implement feature X',
  agent: 'gemini-worker'
});
```

### Step 4: Never Invent VTIDs

❌ **FORBIDDEN:**
```typescript
const vtid = 'DEV-PLAN-0001';  // Never hardcode
const vtid = generateVtid();   // Never generate locally
```

✅ **REQUIRED:**
```typescript
const vtid = await getOrCreateVtid();  // Always use the API
```

## Context Checking

Before creating a new VTID, check if one already exists:

```typescript
async function getTaskVtid(taskContext: any): Promise<string> {
  // 1. Check if VTID already in context
  if (taskContext.vtid) {
    // Validate it exists
    const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vtid: taskContext.vtid })
    });

    const result = await response.json();
    if (result.ok) {
      return result.vtid;  // Reuse existing
    }
  }

  // 2. Create new if needed
  return await startPlanningSession();
}
```

## OASIS Event Logging

Log all planning milestones:

```typescript
await logOasisEvent({
  vtid: context.vtid,
  type: 'PLAN_CREATED',
  source: 'gemini-planner',
  status: 'success',
  message: 'Task plan created',
  metadata: {
    stepCount: plan.steps.length,
    assignedAgents: plan.assignedAgents
  }
});
```

## Validation

All outputs will be validated against governance rules VTID-001, VTID-002, and VTID-003.
