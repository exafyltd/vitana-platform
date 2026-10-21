/**
 * VTID-05069: a minimal DOM for rendering Command Hub modules in node Jest
 * (createElement, appendChild, attributes, textContent, click listeners).
 * Test-only; never served.
 */
export class FakeEl {
  tagName: string;
  className = '';
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  private ownText = '';
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.ownText = v; this.children = []; }
  get firstChild(): FakeEl | null { return this.children[0] ?? null; }
  appendChild(c: FakeEl): FakeEl { this.children.push(c); return c; }
  removeChild(c: FakeEl): FakeEl { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev: string, fn: () => void): void { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click(): void { (this.listeners.click || []).forEach((f) => f()); }
  /** Every descendant (depth first) whose class list has `cls`. */
  all(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.children) { if (c.className.split(/\s+/).includes(cls)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  one(cls: string): FakeEl {
    const r = this.all(cls);
    if (!r.length) throw new Error(`no .${cls}`);
    return r[0];
  }
  byTag(tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.children) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

export const fakeDocument = { createElement: (tag: string) => new FakeEl(tag) };
