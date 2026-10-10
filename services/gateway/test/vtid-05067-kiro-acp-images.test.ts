/**
 * VTID-05067: images pasted into a Kiro thread reach Kiro as ACP image blocks — only when
 * kiro-cli advertised image input at initialize (agentCapabilities.promptCapabilities.image);
 * otherwise the prompt carries one text line saying so, and a `kiro.images` event (and the
 * reply meta) tells the console "Kiro can't see images in this version". Never silently dropped.
 *
 * The real ACP client and turn runner run against a scripted fake `kiro-cli acp` that
 * advertises (or does not advertise) image input.
 */
import { EventEmitter } from 'events';
import { AcpClient, type AcpChild } from '../src/services/kiro/acp-client';
import { setKiroBackend, runKiroTurn, closeAllKiroSessions, imagesUnsupportedLine } from '../src/services/kiro/kiro-turn';
import type { KiroTurnEvent } from '../src/services/kiro/kiro-events';

function fakeKiro(caps: Record<string, unknown> | undefined): AcpChild & { written: any[] } {
  const out = new EventEmitter();
  const proc = new EventEmitter();
  const written: any[] = [];
  const send = (o: unknown) => out.emit('data', `${JSON.stringify(o)}\n`);
  const child: any = {
    written,
    stdout: out,
    stdin: {
      write: (line: string) => {
        const msg = JSON.parse(line);
        written.push(msg);
        if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, ...(caps ? { agentCapabilities: caps } : {}) } });
        else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S1' } });
        else if (msg.method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'seen' } } } });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
        return true;
      },
      end: () => {},
    },
    kill() { proc.emit('exit'); },
    on: (ev: string, cb: any) => proc.on(ev, cb),
  };
  return child;
}

const ENV = { KIRO_ENGINE_ENABLED: 'true' } as NodeJS.ProcessEnv;
const PNG = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
const JPG = { mimeType: 'image/jpeg', data: '/9j/4AAQ' };
let child: ReturnType<typeof fakeKiro>;
const lastPrompt = () => child.written.filter((m) => m.method === 'session/prompt').pop().params.prompt;

function useKiro(caps: Record<string, unknown> | undefined) {
  setKiroBackend({ spawn: () => { child = fakeKiro(caps); return child; }, workspace: () => '/work/img' });
}
afterEach(() => { closeAllKiroSessions(); setKiroBackend(null); });

describe('AcpClient keeps the agent capabilities from initialize', () => {
  it('advertised image input → acceptsImages(); absent or false → not', async () => {
    for (const [caps, want] of [[{ promptCapabilities: { image: true } }, true], [{ promptCapabilities: { image: false } }, false], [undefined, false], [{}, false]] as const) {
      const c = new AcpClient(fakeKiro(caps as any));
      await c.initialize();
      expect(c.acceptsImages()).toBe(want);
      expect(c.agentCapabilities).toEqual(caps ?? {});
    }
  });

  it('prompt() puts image blocks after the text blocks, base64 + MIME type, ACP shape', async () => {
    const k = fakeKiro({ promptCapabilities: { image: true } });
    const c = new AcpClient(k);
    await c.initialize();
    await c.prompt('S1', 'look', undefined, 'ctx', [PNG, JPG]);
    const p = k.written.find((m) => m.method === 'session/prompt').params.prompt;
    expect(p).toEqual([
      { type: 'text', text: 'ctx' },
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
    ]);
  });
});

describe('runKiroTurn with attached images', () => {
  it('Kiro accepts images: the prompt carries them as image blocks; event + meta say sent', async () => {
    useKiro({ promptCapabilities: { image: true, embeddedContext: true } });
    const events: KiroTurnEvent[] = [];
    const loadImages = jest.fn(async () => [PNG, JPG]);
    const r = await runKiroTurn({ threadId: 't-img', userId: 'u1', message: 'what is broken here?', imageCount: 2, loadImages, emit: (e) => events.push(e) }, ENV);
    expect(loadImages).toHaveBeenCalledTimes(1);
    const prompt = lastPrompt();
    expect(prompt.filter((b: any) => b.type === 'image')).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
    ]);
    expect(prompt.find((b: any) => b.type === 'text' && b.text.startsWith('what is broken here?')).text).toBe('what is broken here?');
    expect(events.find((e) => e.type === 'kiro.images')).toEqual({ type: 'kiro.images', count: 2, delivery: 'sent', sent: 2 });
    expect(r.meta).toMatchObject({ kiro_status: 'ok', kiro_images: 'sent', kiro_images_count: 2 });
  });

  it('Kiro does not accept images: no image block, one text line instead, nothing read from storage; event + meta say unsupported', async () => {
    useKiro({ promptCapabilities: { image: false } });
    const events: KiroTurnEvent[] = [];
    const loadImages = jest.fn(async () => [PNG]);
    const r = await runKiroTurn({ threadId: 't-noimg', userId: 'u1', message: 'see the screenshot', imageCount: 1, loadImages, emit: (e) => events.push(e) }, ENV);
    expect(loadImages).not.toHaveBeenCalled();
    const prompt = lastPrompt();
    expect(prompt.some((b: any) => b.type === 'image')).toBe(false);
    const msg = prompt[prompt.length - 1];
    expect(msg).toEqual({ type: 'text', text: `see the screenshot\n\n${imagesUnsupportedLine(1)}` });
    expect(imagesUnsupportedLine(1)).toBe('The user attached 1 image(s) that this agent cannot view.');
    expect(events.find((e) => e.type === 'kiro.images')).toEqual({ type: 'kiro.images', count: 1, delivery: 'unsupported', sent: 0 });
    expect(r.meta).toMatchObject({ kiro_images: 'unsupported', kiro_images_count: 1 });
  });

  it('a kiro-cli that reports no capabilities at all is treated as not accepting images', async () => {
    useKiro(undefined);
    const r = await runKiroTurn({ threadId: 't-old', userId: 'u1', message: 'x', imageCount: 3, loadImages: async () => [PNG, PNG, PNG] }, ENV);
    expect(lastPrompt().some((b: any) => b.type === 'image')).toBe(false);
    expect(r.meta.kiro_images).toBe('unsupported');
  });

  it('an image that cannot be read is said in the prompt and reported as unreadable', async () => {
    useKiro({ promptCapabilities: { image: true } });
    const events: KiroTurnEvent[] = [];
    const r = await runKiroTurn({ threadId: 't-part', userId: 'u1', message: 'two shots', imageCount: 2, loadImages: async () => [PNG], emit: (e) => events.push(e) }, ENV);
    const prompt = lastPrompt();
    expect(prompt.filter((b: any) => b.type === 'image')).toHaveLength(1);
    expect(prompt.find((b: any) => b.type === 'text' && b.text.startsWith('two shots')).text).toBe('two shots\n\n(1 attached image(s) could not be loaded.)');
    expect(events.find((e) => e.type === 'kiro.images')).toEqual({ type: 'kiro.images', count: 2, delivery: 'unreadable', sent: 1 });
    expect(r.meta.kiro_images).toBe('unreadable');
  });

  it('no images: the prompt and meta are exactly as before', async () => {
    useKiro({ promptCapabilities: { image: true } });
    const events: KiroTurnEvent[] = [];
    const r = await runKiroTurn({ threadId: 't-plain', userId: 'u1', message: 'plain', emit: (e) => events.push(e) }, ENV);
    expect(events.some((e) => e.type === 'kiro.images')).toBe(false);
    expect(r.meta.kiro_images).toBeUndefined();
    const prompt = lastPrompt();
    expect(prompt[prompt.length - 1]).toEqual({ type: 'text', text: 'plain' });
  });
});
