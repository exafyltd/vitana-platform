/**
 * Vitana CI/CD Skill for OpenClaw
 *
 * GitHub PR management, safe merge orchestration,
 * deployment workflows, approval pipelines,
 * and deployment lock management.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CreatePRSchema = z.object({
  tenant_id: z.string().uuid(),
  vtid: z.string().min(1).max(50),
  branch: z.string().min(1).max(255),
  title: z.string().min(1).max(255),
  body: z.string().max(10000).optional(),
});

const SafeMergeSchema = z.object({
  tenant_id: z.string().uuid(),
  vtid: z.string().min(1).max(50),
  pr_number: z.number().int().positive(),
});

const DeployServiceSchema = z.object({
  tenant_id: z.string().uuid(),
  vtid: z.string().min(1).max(50),
  service: z.string().min(1).max(100),
  environment: z.enum(['staging', 'production']).default('staging'),
});

const ApprovalActionSchema = z.object({
  tenant_id: z.string().uuid(),
  approval_id: z.string().uuid(),
  vtid: z.string().min(1).max(50).optional(),
});

const ListApprovalsSchema = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
});

const AutonomousMergeSchema = z.object({
  tenant_id: z.string().uuid(),
  vtid: z.string().min(1).max(50),
  pr_number: z.number().int().positive(),
  auto_deploy: z.boolean().default(false),
});

const LockStatusSchema = z.object({
  tenant_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CI/CD endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Create a GitHub PR for a VTID.
   */
  async create_pr(input: unknown) {
    const { tenant_id, vtid, branch, title, body } = CreatePRSchema.parse(input);

    const data = await callGateway('/github/create-pr', 'POST', {
      tenant_id,
      vtid,
      branch,
      title,
      body,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'cicd.pr_created',
      actor: 'openclaw-autopilot',
      details: { vtid, branch, title },
      created_at: new Date().toISOString(),
    });

    return { success: true, pr: data };
  },

  /**
   * Trigger a safe merge with CI/governance gates.
   */
  async safe_merge(input: unknown) {
    const { tenant_id, vtid, pr_number } = SafeMergeSchema.parse(input);

    const data = await callGateway('/github/safe-merge', 'POST', {
      tenant_id,
      vtid,
      pr_number,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'cicd.safe_merge',
      actor: 'openclaw-autopilot',
      details: { vtid, pr_number },
      created_at: new Date().toISOString(),
    });

    return { success: true, merge: data };
  },

  /**
   * Trigger a service deployment.
   */
  async deploy(input: unknown) {
    const { tenant_id, vtid, service, environment } = DeployServiceSchema.parse(input);

    const data = await callGateway('/deploy/service', 'POST', {
      tenant_id,
      vtid,
      service,
      environment,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'cicd.deploy_triggered',
      actor: 'openclaw-autopilot',
      details: { vtid, service, environment },
      created_at: new Date().toISOString(),
    });

    return { success: true, deployment: data };
  },

  /**
   * List pending approval items.
   */
  async list_approvals(input: unknown) {
    const { tenant_id, limit } = ListApprovalsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/cicd/approvals?${params.toString()}`, 'GET');
    return { success: true, approvals: data };
  },

  /**
   * Approve a pending approval and execute.
   */
  async approve(input: unknown) {
    const { tenant_id, approval_id, vtid } = ApprovalActionSchema.parse(input);

    const data = await callGateway(`/cicd/approvals/${approval_id}/approve`, 'POST', {
      tenant_id,
      vtid,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'cicd.approval_approved',
      actor: 'openclaw-autopilot',
      details: { approval_id, vtid },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Deny a pending approval.
   */
  async deny(input: unknown) {
    const { tenant_id, approval_id, vtid } = ApprovalActionSchema.parse(input);

    const data = await callGateway(`/cicd/approvals/${approval_id}/deny`, 'POST', {
      tenant_id,
      vtid,
      source: 'openclaw-autopilot',
    });

    return { success: true, result: data };
  },

  /**
   * Autonomous PR merge: approve → safe merge → auto-deploy.
   */
  async autonomous_merge(input: unknown) {
    const { tenant_id, vtid, pr_number, auto_deploy } = AutonomousMergeSchema.parse(input);

    const data = await callGateway('/cicd/autonomous-pr-merge', 'POST', {
      tenant_id,
      vtid,
      pr_number,
      auto_deploy,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'cicd.autonomous_merge',
      actor: 'openclaw-autopilot',
      details: { vtid, pr_number, auto_deploy },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Get deployment lock status.
   */
  async lock_status(input: unknown) {
    const { tenant_id } = LockStatusSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);

    const data = await callGateway(`/cicd/lock-status?${params.toString()}`, 'GET');
    return { success: true, lock: data };
  },
};

export const SKILL_META = {
  name: 'vitana-cicd',
  description: 'GitHub PR management, safe merge, deployment orchestration, and approval pipelines',
  actions: Object.keys(actions),
};
