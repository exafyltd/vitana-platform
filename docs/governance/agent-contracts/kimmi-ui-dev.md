# Kimmi UI/Dev Agent Contract

**VTID:** DEV-OASIS-0206
**Version:** 1.0
**Agent Type:** UI Development/Design Implementation

## Role

The Kimmi agent handles UI development tasks, component implementation, styling, and frontend changes. It operates on the Lovable platform for Vitana frontend development.

## VTID Protocol

### Step 1: Obtain VTID at Task Start

At the start of ANY UI task, call the VTID endpoint:

```typescript
async function startUITask(existingVtid?: string): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/api/v1/vtid/get-or-create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vtid: existingVtid || undefined,
      task_family: 'DEV',
      task_module: 'FRONT',  // Frontend module
      title: 'Kimmi UI Development Task',
      agent: 'kimmi-ui-dev'
    })
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`VTID allocation failed: ${result.error}`);
  }

  return result.vtid;
}
```

### Step 2: Store VTID in Working Context

```typescript
interface KimmiContext {
  vtid: string;
  taskType: 'component' | 'styling' | 'layout' | 'integration';
  targetFile?: string;
  startedAt: string;
}

const context: KimmiContext = {
  vtid: await startUITask(),
  taskType: 'component',
  startedAt: new Date().toISOString()
};
```

### Step 3: Include VTID in All Operations

```typescript
// In file headers
/*
 * VTID: ${context.vtid}
 * Component: UserProfile
 * Created by: kimmi-ui-dev
 */

// In OASIS events
await logOasisEvent({
  vtid: context.vtid,
  type: 'UI_COMPONENT_CREATED',
  source: 'kimmi-ui-dev',
  status: 'success',
  message: 'Created UserProfile component',
  metadata: {
    component: 'UserProfile',
    path: 'src/components/UserProfile.tsx'
  }
});

// In commit messages
git commit -m "[${context.vtid}] Add UserProfile component"
```

### Step 4: Never Invent VTIDs

❌ **FORBIDDEN:**
```typescript
const vtid = 'DEV-FRONT-0001';  // Never hardcode
const vtid = 'DEV-UI-' + Date.now();  // Never generate locally
```

✅ **REQUIRED:**
```typescript
const vtid = await getOrCreateVtid();  // Always use the API
```

## UI-Specific Governance

Kimmi must also comply with:

| Rule | Description |
|------|-------------|
| CSP-001 | No inline scripts |
| CSP-002 | No external CDNs |
| NAV-001 | Sidebar Canon Rule |
| UI-001 | Golden Command Hub Task Board |
| UI-002 | Fixed Layout Regions |

## Component Creation Flow

```typescript
async function createComponent(name: string): Promise<void> {
  // 1. Get or create VTID
  const vtid = await startUITask();

  // 2. Log start
  await logOasisEvent({
    vtid,
    type: 'UI_TASK_STARTED',
    source: 'kimmi-ui-dev',
    status: 'info',
    message: `Starting component: ${name}`
  });

  // 3. Create component (implementation)
  // ... actual component code ...

  // 4. Log completion
  await logOasisEvent({
    vtid,
    type: 'UI_TASK_COMPLETED',
    source: 'kimmi-ui-dev',
    status: 'success',
    message: `Completed component: ${name}`
  });
}
```

## Error Handling

```typescript
try {
  const vtid = await startUITask();
  // ... UI work ...
} catch (error) {
  // Log with error status but still include VTID tracking
  await logOasisEvent({
    vtid: context.vtid || 'DEV-ERROR-KIMMI',
    type: 'UI_TASK_FAILED',
    source: 'kimmi-ui-dev',
    status: 'error',
    message: error.message
  });
}
```

## Validation

All Kimmi outputs are validated by the Validator against VTID governance rules and UI governance rules.
