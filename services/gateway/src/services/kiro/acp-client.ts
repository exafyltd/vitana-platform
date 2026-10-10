/**
 * VTID-04975: minimal ACP (Agent Client Protocol) client for `kiro-cli acp`.
 *
 * JSON-RPC 2.0, one JSON object per line over the child's stdin/stdout.
 * Methods used: initialize, session/new, session/load, session/prompt,
 * session/cancel. Incoming: session notifications and the agent's
 * session/request_permission request, which the caller answers through
 * `onPermissionRequest` (default: deny).
 *
 * The child process is injected so tests drive a fake one and the Phase 2
 * runner supplies the real `kiro-cli acp` spawn. No key handling lives here.
 */
import type { Readable, Writable } from 'stream';

export interface AcpChild {
  stdin: Pick<Writable, 'write' | 'end'>;
  stdout: Pick<Readable, 'on'>;
  kill(): void;
  on(event: 'exit' | 'error', cb: (...args: any[]) => void): unknown;
  /** VTID-05064: what the kiro-runner reported about this session's workspace (remote backend only). */
  runner?: KiroRunnerInfo;
  /**
   * VTID-05068: let go of the runner socket WITHOUT ending the session (close 1001), so another
   * gateway task can reattach it. Remote backend only.
   */
  detach?(): void;
}

/**
 * VTID-05064: the runner's status frames. `workspace`: the session reopened the thread's
 * parked workspace ('restored') or started empty ('fresh'). `dirty`: repos with uncommitted
 * edits, as of the latest finished prompt (null until the first one).
 */
export interface KiroRunnerInfo {
  workspace: 'restored' | 'fresh' | null; dirty: string[] | null;
  /**
   * VTID-05068: set on a REATTACHED session — the ACP session id and the session/prompt request
   * ids (sent by the gateway task that dropped) still unanswered when its socket dropped.
   */
  reattached?: { sessionId: string | null; pendingPrompts: number[] } | null;
}

export interface AcpPermissionOption { optionId: string; name?: string; kind?: string }
export interface AcpPermissionRequest {
  sessionId: string | null;
  toolCallId: string | null;
  title: string;
  kind: string;
  options: AcpPermissionOption[];
}
/** Resolve to the optionId to select, or null to cancel (deny). */
export type AcpPermissionHandler = (req: AcpPermissionRequest) => Promise<string | null>;

export interface AcpClientOptions {
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  onPermissionRequest?: AcpPermissionHandler;
}

/**
 * VTID-04984: the models Kiro offers for a session. Kiro reports them either
 * as an ACP config option with category "model" (switched with
 * session/set_config_option) or, on its v2 engine, as a `models` field
 * (switched with session/set_model).
 * Sources: https://agentclientprotocol.com/protocol/session-config-options and
 * https://kiro.dev/docs/cli/acp/ ("session/set_model … CLI v2 only — CLI V3
 * uses session/set_config_option").
 */
export interface KiroModel { id: string; name: string; description?: string }
export interface KiroModelState {
  models: KiroModel[];
  current: string | null;
  via: 'config_option' | 'set_model';
  configId?: string;
}

function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }

/** Read Kiro's model list out of a session/new (or set) result. */
export function parseModelState(result: unknown): KiroModelState | null {
  const r = (result ?? {}) as Record<string, any>;
  const opts: any[] = Array.isArray(r.configOptions) ? r.configOptions : [];
  const opt = opts.find((o) => o && o.category === 'model') ?? opts.find((o) => o && o.id === 'model');
  if (opt && Array.isArray(opt.options)) {
    const models: KiroModel[] = [];
    for (const entry of opt.options) {
      const list = Array.isArray(entry?.options) ? entry.options : [entry]; // groups or plain values
      for (const o of list) {
        const id = str(o?.value);
        if (id) models.push({ id, name: str(o.name) ?? id, ...(str(o.description) ? { description: str(o.description) } : {}) });
      }
    }
    return { models, current: str(opt.currentValue) ?? null, via: 'config_option', configId: String(opt.id) };
  }
  const m = r.models;
  if (m && Array.isArray(m.availableModels)) {
    const models: KiroModel[] = m.availableModels
      .map((o: any) => ({ id: str(o?.modelId) ?? '', name: str(o?.name) ?? str(o?.modelId) ?? '', ...(str(o?.description) ? { description: str(o.description) } : {}) }))
      .filter((x: KiroModel) => x.id);
    return { models, current: str(m.currentModelId) ?? null, via: 'set_model' };
  }
  return null;
}

export class AcpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = 'AcpError'; }
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }

export const ACP_PROTOCOL_VERSION = 1;

/** VTID-05005: how long one Kiro turn may run; the user can Stop it sooner. */
export const KIRO_PROMPT_TIMEOUT_MS = 15 * 60_000;

export class AcpClient {
  private nextId = 1;
  private buf = '';
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** VTID-05068: let go for another gateway task — pending requests stay unanswered here, never failed. */
  private detached = false;

  constructor(private readonly child: AcpChild, private readonly opts: AcpClientOptions = {}) {
    child.stdout.on('data', (chunk: Buffer | string) => this.onData(String(chunk)));
    child.on('exit', () => this.failAll(new AcpError('kiro-cli exited')));
    child.on('error', (e: Error) => this.failAll(new AcpError(`kiro-cli error: ${e.message}`)));
  }

  private onData(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON log noise
    if (msg && typeof msg === 'object') {
      if (msg.method && msg.id !== undefined) { void this.onAgentRequest(msg); return; }
      if (msg.method) { this.opts.onNotification?.(String(msg.method), msg.params); return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id));
        if (!p) return;
        this.pending.delete(Number(msg.id));
        if (p.timer) clearTimeout(p.timer);
        if (msg.error) p.reject(new AcpError(String(msg.error.message ?? 'ACP error'), msg.error.code));
        else p.resolve(msg.result);
      }
    }
  }

  private async onAgentRequest(msg: any): Promise<void> {
    if (msg.method === 'session/request_permission') {
      const params = msg.params ?? {};
      const tc = params.toolCall ?? {};
      const req: AcpPermissionRequest = {
        sessionId: params.sessionId ?? null,
        toolCallId: tc.toolCallId ?? null,
        title: String(tc.title ?? ''),
        kind: String(tc.kind ?? 'other'),
        options: Array.isArray(params.options) ? params.options : [],
      };
      let optionId: string | null = null;
      try { optionId = this.opts.onPermissionRequest ? await this.opts.onPermissionRequest(req) : null; } catch { optionId = null; }
      const outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
      this.write({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
      return;
    }
    this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private failAll(err: Error): void {
    this.closed = true;
    if (this.detached) return;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  request<T = any>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 0): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError('ACP connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new AcpError(`ACP ${method} timed out`)); }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    return (await this.openNewSession(cwd, mcpServers)).sessionId;
  }

  /** VTID-04984: session/new, keeping the model list Kiro returns with it. */
  async openNewSession(cwd: string, mcpServers: unknown[] = []): Promise<{ sessionId: string; models: KiroModelState | null }> {
    const r = await this.request<{ sessionId: string }>('session/new', { cwd, mcpServers });
    if (!r?.sessionId) throw new AcpError('session/new returned no sessionId');
    return { sessionId: r.sessionId, models: parseModelState(r) };
  }

  /** VTID-04984: switch the session's model the way Kiro reported it. Kiro's own error is thrown as-is. */
  async setModel(sessionId: string, state: KiroModelState, modelId: string): Promise<KiroModelState> {
    if (state.via === 'config_option') {
      const r = await this.request('session/set_config_option', { sessionId, configId: state.configId ?? 'model', value: modelId });
      return parseModelState(r) ?? { ...state, current: modelId };
    }
    await this.request('session/set_model', { sessionId, modelId });
    return { ...state, current: modelId };
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    await this.request('session/load', { sessionId, cwd, mcpServers });
  }

  /** Resolves with the stop reason when the turn finishes. */
  /** VTID-05005: a turn runs as long as Kiro works (tools included), not the 30 s request default. */
  /** VTID-05018: `context`, when given, is sent as its own leading block (restored thread history). */
  async prompt(sessionId: string, text: string, timeoutMs: number = KIRO_PROMPT_TIMEOUT_MS, context?: string): Promise<{ stopReason: string }> {
    const prompt = context ? [{ type: 'text', text: context }, { type: 'text', text }] : [{ type: 'text', text }];
    const r = await this.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt }, timeoutMs);
    return { stopReason: String(r?.stopReason ?? 'end_turn') };
  }

  /**
   * VTID-05068: wait for the answer to request `id` that an EARLIER client (another gateway
   * task) sent on this same kiro-cli session; the runner replays that answer after a reattach.
   * Register before the replayed frames are read. Later ids of this client never collide.
   */
  adopt<T = any>(id: number, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError('ACP connection closed'));
    if (id >= this.nextId) this.nextId = id + 1;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new AcpError('ACP adopted request timed out')); }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /**
   * VTID-05068: this gateway task is going away and another one will reattach the session:
   * stop writing, keep every pending request unanswered (the turn is not failed here), and
   * close the runner socket with "going away" so the runner keeps kiro-cli alive.
   */
  detach(): boolean {
    if (this.closed || !this.child.detach) return false;
    this.detached = true;
    this.closed = true;
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    try { this.child.detach(); } catch { /* closing */ }
    return true;
  }

  cancel(sessionId: string): void {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  close(): void {
    if (this.closed) return;
    this.failAll(new AcpError('ACP connection closed'));
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}
