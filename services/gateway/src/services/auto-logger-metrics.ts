interface MetricsSnapshot {
  sent: number;
  failed: number;
  template_missing: number;
  lastResetAt: string | null;
  lastTelemetryAt: string | null;
}

interface TelemetrySchedulerOptions {
  emitEvent: (payload: any) => Promise<void> | void;
  intervalMinutes?: number;
}

export class AutoLoggerMetrics {
  private sent: number = 0;
  private failed: number = 0;
  private templateMissing: number = 0;
  private lastResetAt: string | null = null;
  private lastTelemetryAt: string | null = null;
  private telemetryIntervalId: NodeJS.Timeout | null = null;

  public incrementSent(): void { this.sent++; }
  public incrementFailed(): void { this.failed++; }
  public incrementTemplateMissing(): void { this.templateMissing++; }

  public getSnapshot(): MetricsSnapshot {
    return { sent: this.sent, failed: this.failed, template_missing: this.templateMissing, lastResetAt: this.lastResetAt, lastTelemetryAt: this.lastTelemetryAt };
  }

  public startTelemetryScheduler(opts: TelemetrySchedulerOptions): void {
    const intervalMinutes = opts.intervalMinutes ?? 60;
    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`[AutoLoggerMetrics] Starting telemetry (${intervalMinutes}min)`);
    this.telemetryIntervalId = setInterval(() => this.emitTelemetry(opts.emitEvent), intervalMs);
  }

  public stopTelemetryScheduler(): void {
    if (this.telemetryIntervalId) { clearInterval(this.telemetryIntervalId); this.telemetryIntervalId = null; }
  }

  private async emitTelemetry(emitEvent: (payload: any) => Promise<void> | void): Promise<void> {
    try {
      const payload = { service: 'auto-logger', event: 'telemetry.report', tenant: 'vitana', status: 'info', metadata: { sent: this.sent, failed: this.failed, template_missing: this.templateMissing } };
      await emitEvent(payload);
      this.lastTelemetryAt = new Date().toISOString();
      this.resetCounters();
    } catch (error) { console.error('[AutoLoggerMetrics] Error:', error); }
  }

  private resetCounters(): void {
    this.sent = 0; this.failed = 0; this.templateMissing = 0; this.lastResetAt = new Date().toISOString();
  }
}

export const autoLoggerMetrics = new AutoLoggerMetrics();
