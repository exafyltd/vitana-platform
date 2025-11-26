/**
 * OASIS Event Service
 * VTID: VTID-0512 (Safe Merge + Auto-Deploy Bridge)
 *
 * Centralized service for emitting OASIS events for CI/CD operations.
 */

import { randomUUID } from 'crypto';

export interface OasisEventPayload {
  vtid: string;
  topic: string;
  service: string;
  status: 'pending' | 'success' | 'error' | 'info' | 'warning';
  message: string;
  link?: string;
  metadata?: Record<string, any>;
}

export class OasisEventService {
  private supabaseUrl: string | undefined;
  private supabaseKey: string | undefined;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  }

  /**
   * Emit an OASIS event for CI/CD operations
   */
  async emit(payload: OasisEventPayload): Promise<{ ok: boolean; eventId?: string; error?: string }> {
    if (!this.supabaseUrl || !this.supabaseKey) {
      console.warn('[OasisEventService] Supabase not configured - event not logged to DB');
      console.log(`[OASIS] Event (local only): ${payload.topic}`, payload);
      return { ok: true, eventId: 'local-only' };
    }

    const eventId = randomUUID();
    const timestamp = new Date().toISOString();

    const dbPayload = {
      id: eventId,
      created_at: timestamp,
      vtid: payload.vtid,
      topic: payload.topic,
      service: payload.service,
      role: 'SYSTEM',
      model: 'safe-merge-bot',
      status: payload.status,
      message: payload.message,
      link: payload.link || null,
      metadata: payload.metadata || {},
    };

    try {
      const resp = await fetch(`${this.supabaseUrl}/rest/v1/oasis_events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(dbPayload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[OasisEventService] Insert failed: ${resp.status} - ${text}`);
        return { ok: false, error: `Database insert failed: ${resp.status}` };
      }

      console.log(`[OASIS] Event emitted: ${eventId} - ${payload.vtid}/${payload.topic}`);
      return { ok: true, eventId };
    } catch (error: any) {
      console.error('[OasisEventService] Error:', error);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Emit a Safe Merge request event
   */
  async emitSafeMergeRequest(vtid: string, prNumber: number, repo: string): Promise<void> {
    await this.emit({
      vtid,
      topic: 'SAFE_MERGE_REQUEST',
      service: 'cicd',
      status: 'pending',
      message: `Safe merge requested for PR #${prNumber}`,
      link: `https://github.com/${repo}/pull/${prNumber}`,
      metadata: { pr_number: prNumber, repo },
    });
  }

  /**
   * Emit a Safe Merge executed event
   */
  async emitSafeMergeExecuted(
    vtid: string,
    prNumber: number,
    repo: string,
    commitSha: string
  ): Promise<void> {
    await this.emit({
      vtid,
      topic: 'SAFE_MERGE_EXECUTED',
      service: 'cicd',
      status: 'success',
      message: `PR #${prNumber} merged successfully`,
      link: `https://github.com/${repo}/pull/${prNumber}`,
      metadata: { pr_number: prNumber, repo, commit_sha: commitSha, merged_by: 'safe-merge-bot' },
    });
  }

  /**
   * Emit a Safe Merge denied event
   */
  async emitSafeMergeDenied(
    vtid: string,
    prNumber: number,
    repo: string,
    reason: string
  ): Promise<void> {
    await this.emit({
      vtid,
      topic: 'SAFE_MERGE_DENIED',
      service: 'cicd',
      status: 'error',
      message: `Safe merge denied for PR #${prNumber}: ${reason}`,
      link: `https://github.com/${repo}/pull/${prNumber}`,
      metadata: { pr_number: prNumber, repo, reason },
    });
  }

  /**
   * Emit a Deploy request event
   */
  async emitDeployRequest(
    vtid: string,
    service: string,
    environment: string,
    workflowRunId?: number
  ): Promise<void> {
    await this.emit({
      vtid,
      topic: 'DEPLOY_REQUEST',
      service,
      status: 'pending',
      message: `Deploy requested for ${service} to ${environment}`,
      metadata: { service, environment, workflow_run_id: workflowRunId },
    });
  }

  /**
   * Emit a Deploy succeeded event
   */
  async emitDeploySucceeded(vtid: string, service: string, environment: string): Promise<void> {
    await this.emit({
      vtid,
      topic: 'DEPLOY_SUCCEEDED',
      service,
      status: 'success',
      message: `${service} deployed successfully to ${environment}`,
      metadata: { service, environment },
    });
  }

  /**
   * Emit a Deploy failed event
   */
  async emitDeployFailed(
    vtid: string,
    service: string,
    environment: string,
    reason: string
  ): Promise<void> {
    await this.emit({
      vtid,
      topic: 'DEPLOY_FAILED',
      service,
      status: 'error',
      message: `Deploy failed for ${service} to ${environment}: ${reason}`,
      metadata: { service, environment, reason },
    });
  }
}

// Singleton instance
export const oasisEventService = new OasisEventService();
