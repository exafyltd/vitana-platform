import { AutoLoggerMetrics } from '../src/services/AutoLoggerMetrics';

describe('AutoLoggerMetrics', () => {
  let metrics: AutoLoggerMetrics;
  beforeEach(() => { metrics = new AutoLoggerMetrics(); });
  afterEach(() => { metrics.stopTelemetryScheduler(); });

  it('should increment sent counter', () => {
    metrics.incrementSent();
    metrics.incrementSent();
    expect(metrics.getSnapshot().sent).toBe(2);
  });

  it('should increment failed counter', () => {
    metrics.incrementFailed();
    expect(metrics.getSnapshot().failed).toBe(1);
  });

  it('should increment template_missing counter', () => {
    metrics.incrementTemplateMissing();
    expect(metrics.getSnapshot().template_missing).toBe(1);
  });

  it('should return correct snapshot', () => {
    metrics.incrementSent();
    metrics.incrementFailed();
    const snapshot = metrics.getSnapshot();
    expect(snapshot.sent).toBe(1);
    expect(snapshot.failed).toBe(1);
  });
});
