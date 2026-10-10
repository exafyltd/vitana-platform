/**
 * VTID-05067: a minimal DOM for loading Command Hub modules (kiro-console.js) under jest's
 * node environment — just what the module uses: createElement, children, replaceChild,
 * attributes, classList, events (addEventListener + on<event> properties).
 */
export class FakeEvent {
  defaultPrevented = false;
  [k: string]: any;
  constructor(public type: string, init: Record<string, any> = {}) { Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
}

export class FakeEl {
  tag: string;
  className = '';
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: any) => void>> = {};
  private _text = '';
  [k: string]: any;

  constructor(tag: string) { this.tag = tag.toUpperCase(); }

  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this._text = String(v); this.children = []; }

  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
      remove: (c: string) => { self.className = list().filter((x) => x !== c).join(' '); },
      contains: (c: string) => list().includes(c),
    };
  }

  appendChild(c: FakeEl) { c.parentNode = this; this.children.push(c); return c; }
  replaceChild(n: FakeEl, o: FakeEl) {
    const i = this.children.indexOf(o);
    if (i < 0) throw new Error('replaceChild: not a child');
    this.children[i] = n; n.parentNode = this; o.parentNode = null;
    return o;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type: string, init: Record<string, any> = {}) {
    const e = new FakeEvent(type, init);
    for (const fn of this.listeners[type] || []) fn(e);
    const prop = this['on' + type];
    if (typeof prop === 'function') prop(e);
    return e;
  }
  click() { return this.dispatch('click'); }

  /** Every element below (and including) this one. */
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(cls: string): FakeEl[] { return this.all().filter((e) => e.className.split(/\s+/).includes(cls)); }
  one(cls: string): FakeEl {
    const f = this.find(cls);
    if (f.length !== 1) throw new Error(`expected one .${cls}, found ${f.length}`);
    return f[0];
  }
  byText(tag: string, text: string | RegExp): FakeEl[] {
    return this.all().filter((e) => e.tag === tag.toUpperCase() && (typeof text === 'string' ? e.textContent === text : text.test(e.textContent)));
  }
}

export function fakeDocument() {
  return { createElement: (t: string) => new FakeEl(t) };
}
