export class ConnectionIssueDebouncer {
  private timers = new Map<string, NodeJS.Timeout>();

  reportIssue(connectionId: string, debounceMs: number, onConfirm: () => void): void {
    if (this.timers.has(connectionId)) {
      clearTimeout(this.timers.get(connectionId));
    }
    
    const timer = setTimeout(() => {
      this.timers.delete(connectionId);
      onConfirm();
    }, debounceMs);
    
    this.timers.set(connectionId, timer);
  }

  resolveIssue(connectionId: string): void {
    if (this.timers.has(connectionId)) {
      clearTimeout(this.timers.get(connectionId));
      this.timers.delete(connectionId);
    }
  }

  cleanup(connectionId: string): void {
    this.resolveIssue(connectionId);
  }
}