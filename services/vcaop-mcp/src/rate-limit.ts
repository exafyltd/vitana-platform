/** Fixed-window per-subject rate limiter (in-process; swap for Redis at scale). */
export interface RateLimiterOptions {
  limitPerWindow: number;
  windowMs: number;
  now?: () => number;
}

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly opts: RateLimiterOptions) {}

  /** Returns true when the request is allowed. */
  allow(key: string): boolean {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const win = this.windows.get(key);
    if (!win || now - win.start >= this.opts.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    win.count += 1;
    return win.count <= this.opts.limitPerWindow;
  }
}
