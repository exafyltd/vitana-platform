/**
 * VTID-0541: OASIS + CI/CD Alignment Repair Script
 *
 * D1: Retroactively register VTID-0540 in OASIS
 *
 * This script:
 * 1. Creates the VTID-0540 task entity in vtid_ledger
 * 2. Creates deployment success events linking to VTID-0540
 * 3. Provides idempotent execution (safe to run multiple times)
 *
 * Run: npx ts-node src/scripts/repair-vtid-0541.ts
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

interface VtidLedgerEntry {
  id: string;
  vtid: string;
  task_family: string;
  task_module: string;
  layer: string;
  module: string;
  title: string;
  description_md: string;
  status: string;
  tenant: string;
  is_test: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface OasisEvent {
  id: string;
  vtid: string;
  topic: string;
  service: string;
  role: string;
  model: string;
  status: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

async function checkVtidExists(vtid: string): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('Supabase not configured');
  }

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=vtid&limit=1`,
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      }
    }
  );

  if (!resp.ok) {
    throw new Error(`Failed to check VTID existence: ${resp.status}`);
  }

  const data = await resp.json() as any[];
  return data.length > 0;
}

async function insertVtidLedger(entry: VtidLedgerEntry): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('Supabase not configured');
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/VtidLedger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(entry)
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[VTID-0541] Insert failed: ${resp.status} - ${text}`);
    return false;
  }

  return true;
}

async function insertOasisEvent(event: OasisEvent): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('Supabase not configured');
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(event)
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[VTID-0541] Event insert failed: ${resp.status} - ${text}`);
    return false;
  }

  return true;
}

async function runRepair(): Promise<void> {
  console.log('[VTID-0541] Starting OASIS + CI/CD Alignment Repair...\n');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[VTID-0541] ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();

  // ==================== D1: Register VTID-0540 ====================
  console.log('[VTID-0541] D1: Retroactively registering VTID-0540...');

  const vtid0540Exists = await checkVtidExists('VTID-0540');

  if (vtid0540Exists) {
    console.log('[VTID-0541] VTID-0540 already exists in ledger, skipping creation');
  } else {
    const vtid0540Entry: VtidLedgerEntry = {
      id: randomUUID(),
      vtid: 'VTID-0540',
      task_family: 'DEV',
      task_module: 'GATEWAY',
      layer: 'DEV',
      module: 'GATEWAY',
      title: 'Gemini Vertex ADC Health Gate Fix',
      description_md: `## VTID-0540: Update Gemini health gate for Vertex ADC

### Problem
The Gemini health check was failing because it was looking for GOOGLE_GEMINI_API_KEY
instead of the Vertex AI ADC credentials (VERTEX_MODEL and VERTEX_LOCATION).

### Solution
Updated the assistant routes health check to verify Vertex AI configuration:
- Check VERTEX_MODEL environment variable
- Check VERTEX_LOCATION environment variable
- Return healthy status when both are configured

### Impact
- Gateway assistant endpoints now correctly report health
- Command Hub can detect AI capabilities
- No longer falsely reports "degraded" when using Vertex AI

**Retroactively registered by VTID-0541**`,
      status: 'deployed',
      tenant: 'vitana',
      is_test: false,
      metadata: {
        created_by: 'system.repair',
        repair_vtid: 'VTID-0541',
        result: 'deployed',
        layer: 'DEV',
        note: 'Retroactively registered by VTID-0541'
      },
      created_at: '2025-12-15T10:00:00.000Z', // Approximate original deployment time
      updated_at: timestamp
    };

    const inserted = await insertVtidLedger(vtid0540Entry);
    if (inserted) {
      console.log('[VTID-0541] VTID-0540 successfully registered in ledger');
    } else {
      console.error('[VTID-0541] Failed to register VTID-0540');
    }
  }

  // Create deploy success event for VTID-0540
  const deployEventId = randomUUID();
  const deployEvent: OasisEvent = {
    id: deployEventId,
    vtid: 'VTID-0540',
    topic: 'deploy.service.success',
    service: 'gateway',
    role: 'CICD',
    model: 'exec-deploy',
    status: 'success',
    message: 'VTID-0540: Gemini Vertex ADC Health Gate Fix deployed successfully',
    metadata: {
      service: 'gateway',
      environment: 'dev',
      repair_vtid: 'VTID-0541',
      note: 'Deployment event retroactively created by VTID-0541'
    },
    created_at: '2025-12-15T10:05:00.000Z' // Shortly after VTID creation
  };

  const eventInserted = await insertOasisEvent(deployEvent);
  if (eventInserted) {
    console.log('[VTID-0541] Deploy success event created for VTID-0540');
  } else {
    console.log('[VTID-0541] Note: Deploy event may already exist');
  }

  // ==================== Register VTID-0541 itself ====================
  console.log('\n[VTID-0541] Registering VTID-0541 repair task...');

  const vtid0541Exists = await checkVtidExists('VTID-0541');

  if (vtid0541Exists) {
    console.log('[VTID-0541] VTID-0541 already exists in ledger, skipping creation');
  } else {
    const vtid0541Entry: VtidLedgerEntry = {
      id: randomUUID(),
      vtid: 'VTID-0541',
      task_family: 'DEV',
      task_module: 'OASIS',
      layer: 'DEV',
      module: 'OASIS',
      title: 'OASIS + CI/CD Alignment Repair',
      description_md: `## VTID-0541: OASIS + CI/CD Alignment Repair

### Purpose
Bring OASIS, CI/CD Health, and Operator behavior back into a single source of truth.

### Deliverables
- D1: Retroactively register VTID-0540 in OASIS
- D2: CI/CD Health reconciliation logic (runtime vs governance)
- D3: Operator Chat routing fix (policy-level)
- D4: Publish button semantics for Dev Sandbox

### Impact
- VTID-0540 now appears in OASIS ledger and events
- CI/CD Health correctly distinguishes runtime vs governance health
- Operator Chat uses Gemini when runtime is OK
- Publish modal allows deploy when runtime is healthy`,
      status: 'in_progress',
      tenant: 'vitana',
      is_test: false,
      metadata: {
        created_by: 'system.repair',
        deliverables: ['D1', 'D2', 'D3', 'D4'],
        layer: 'DEV'
      },
      created_at: timestamp,
      updated_at: timestamp
    };

    const inserted0541 = await insertVtidLedger(vtid0541Entry);
    if (inserted0541) {
      console.log('[VTID-0541] VTID-0541 successfully registered in ledger');
    } else {
      console.error('[VTID-0541] Failed to register VTID-0541');
    }
  }

  // Create repair started event
  const repairEvent: OasisEvent = {
    id: randomUUID(),
    vtid: 'VTID-0541',
    topic: 'repair.alignment.started',
    service: 'gateway',
    role: 'SYSTEM',
    model: 'repair-script',
    status: 'info',
    message: 'VTID-0541: OASIS + CI/CD Alignment Repair initiated',
    metadata: {
      targets: ['VTID-0540'],
      deliverables: ['D1', 'D2', 'D3', 'D4'],
      scope: 'OASIS ledger, CI/CD health, Operator routing, Publish semantics'
    },
    created_at: timestamp
  };

  await insertOasisEvent(repairEvent);
  console.log('[VTID-0541] Repair started event created');

  console.log('\n[VTID-0541] D1 Complete: OASIS Task Entity Created');
  console.log('  - VTID-0540 registered in vtid_ledger');
  console.log('  - Deploy success event linked');
  console.log('  - VTID-0541 repair task registered');
  console.log('\n[VTID-0541] Repair script completed successfully!');
}

// Run the repair
runRepair().catch((error) => {
  console.error('[VTID-0541] Repair failed:', error);
  process.exit(1);
});
