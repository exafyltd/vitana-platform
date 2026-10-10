/**
 * VTID-05054 — Health Hub WP4b-2 (D7 + D5).
 *
 *   D7: AP-0607 tells the member nothing and emits no health.biomarkers.stored
 *       while no lab-report parser exists (the old notice was false, and the
 *       event would have started AP-0608 on nothing).
 *   D5: connector_webhooks_log keeps 90 days; the purge deletes only older
 *       rows, is off unless the flag is exactly 'true', and reports to OASIS.
 */

import * as fs from 'fs';
import * as path from 'path';

const emitOasisEvent = jest.fn(async () => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...(a as [])) }));

const handlers: Record<string, (ctx: any) => Promise<{ usersAffected: number; actionsTaken: number }>> = {};
jest.mock('../src/services/automation-executor', () => ({
  registerHandler: (id: string, fn: (ctx: any) => Promise<any>) => {
    handlers[id] = fn;
  },
}));
jest.mock('../src/services/automation-handlers/health-wellness-repository', () => ({}));

import { registerHealthWellnessHandlers } from '../src/services/automation-handlers/health-wellness';
import {
  isWebhookLogPurgeEnabled,
  purgeConnectorWebhookLog,
  retentionCutoff,
  WEBHOOK_LOG_RETENTION_DAYS,
} from '../src/services/connector-webhook-log-purge';

registerHealthWellnessHandlers();
const AP0607 = 'runLabReportIngestion';

beforeEach(() => jest.clearAllMocks());

describe('AP-0607 lab report ingestion (VTID-05054, D7)', () => {
  function ctx() {
    return {
      run: { metadata: { user_id: 'u1', report_id: 'r1' } },
      supabase: {},
      tenantId: 't1',
      log: jest.fn(),
      notify: jest.fn(),
      emitEvent: jest.fn(async () => undefined),
    };
  }

  it('is registered', () => {
    expect(typeof handlers[AP0607]).toBe('function');
  });

  it('sends no notice and emits no health.biomarkers.stored', async () => {
    const c = ctx();
    const result = await handlers[AP0607](c);
    expect(c.notify).not.toHaveBeenCalled();
    expect(c.emitEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('records the honest outcome in OASIS', async () => {
    await handlers[AP0607](ctx());
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ vtid: 'VTID-05054', type: 'health.lab_report.parse_unavailable', status: 'info' }),
    );
  });

  it('the false English notice is gone from the source', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'automation-handlers', 'health-wellness.ts'),
      'utf8',
    );
    const ap0607 = src.slice(src.indexOf('// ── AP-0607'), src.indexOf('// ── AP-0608'));
    expect(ap0607.length).toBeGreaterThan(100);
    const code = ap0607.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/being analyzed/);
    expect(code).not.toMatch(/Lab Report Received/);
    expect(code).not.toMatch(/health\.biomarkers\.stored'/);
  });
});

describe('connector_webhooks_log 90-day purge (VTID-05054, D5)', () => {
  function fakeDb(rows: Array<{ id: string; received_at: string }>, fail = false) {
    const calls: Array<{ cutoff: string }> = [];
    const db = {
      from: (table: string) => {
        expect(table).toBe('connector_webhooks_log');
        return {
          delete: () => ({
            lt: (col: string, cutoff: string) => {
              expect(col).toBe('received_at');
              calls.push({ cutoff });
              return {
                select: async () =>
                  fail
                    ? { data: null, error: { message: 'boom' } }
                    : { data: rows.filter((r) => r.received_at < cutoff).map((r) => ({ id: r.id })), error: null },
              };
            },
          }),
        };
      },
    };
    return { db: db as any, calls };
  }

  const NOW = new Date('2026-10-10T12:00:00Z');

  it('deletes only rows older than 90 days', async () => {
    const { db, calls } = fakeDb([
      { id: 'old', received_at: '2026-04-16T18:31:16Z' },
      { id: 'edge', received_at: '2026-07-12T12:00:01Z' },
      { id: 'new', received_at: '2026-10-01T00:00:00Z' },
    ]);
    const r = await purgeConnectorWebhookLog(db, NOW);
    expect(calls[0].cutoff).toBe(retentionCutoff(NOW));
    expect(retentionCutoff(NOW)).toBe('2026-07-12T12:00:00.000Z');
    expect(r).toEqual({ ok: true, deleted: 1, cutoff: '2026-07-12T12:00:00.000Z' });
    expect(WEBHOOK_LOG_RETENTION_DAYS).toBe(90);
  });

  it('reports the outcome to OASIS, and a failure as an error', async () => {
    await purgeConnectorWebhookLog(fakeDb([]).db, NOW);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'connector.webhook_log.purged', status: 'info' }));
    const r = await purgeConnectorWebhookLog(fakeDb([], true).db, NOW);
    expect(r.ok).toBe(false);
    expect(emitOasisEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'connector.webhook_log.purged', status: 'error' }));
  });

  it('is off unless the flag is exactly true (staging shares the database)', () => {
    expect(isWebhookLogPurgeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isWebhookLogPurgeEnabled({ CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWebhookLogPurgeEnabled({ CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWebhookLogPurgeEnabled({ CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('the staging deploy workflow never enables the purge', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(wf).not.toMatch(/CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED/);
  });

  it('index.ts schedules the purge only behind the flag', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const i = src.indexOf("require('./services/connector-webhook-log-purge')");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 300)).toContain('purge.isWebhookLogPurgeEnabled()');
  });
});
