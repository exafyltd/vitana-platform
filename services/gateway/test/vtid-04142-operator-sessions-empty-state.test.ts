/**
 * VTID-04142 — the Operator Console thread list must say "No conversations
 * yet" when there are no threads, rather than rendering an empty container.
 *
 * The sessions sidebar (renderOperatorSessionsSidebar(), VTID-03949) already
 * branched on `activeThreads.length === 0` and appended a `.chat-sessions-empty`
 * div, but the text was never pinned by any test — a sibling suite asserted only
 * the class name (`vtid-03949-...test.ts`), so dropping the message while keeping
 * the (now invisible) empty div would have shipped a visually blank sidebar with
 * every check still green. This suite closes that gap.
 *
 * app.js is a plain browser script with no export surface, so — same pattern as
 * vtid-04033's/vtid-04106's suites — the function is extracted out of the file
 * and EVALUATED here against a minimal DOM stub, instead of only grepping the
 * source text. That is what lets this test assert the rendered result (a child
 * element carrying the visible message) for both the empty and the non-empty
 * thread list, rather than merely the presence of a string literal.
 */

import * as fs from 'fs';
import * as path from 'path';

const FE = path.resolve(__dirname, '../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const GUARD_JS = fs.readFileSync(
  path.resolve(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'),
  'utf8',
);

/** Body of a top-level `function <name>(...) { ... }` declaration, from the
 * signature to the first `\n}` (the file's column-0 closing brace). */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

// ---------------------------------------------------------------------------
// A DOM stub just rich enough for this renderer: createElement returns a node
// with the properties the sidebar sets, and appendChild records the tree so a
// test can walk it.
// ---------------------------------------------------------------------------

interface StubEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  title: string;
  onclick: (() => void) | null;
  dataset: Record<string, string>;
  children: StubEl[];
  appendChild(child: StubEl): StubEl;
}

function stubDocument(): { createElement: (tagName: string) => StubEl } {
  return {
    createElement(tagName: string): StubEl {
      return {
        tagName,
        className: '',
        textContent: '',
        type: '',
        title: '',
        onclick: null,
        dataset: {},
        children: [],
        appendChild(child: StubEl): StubEl {
          this.children.push(child);
          return child;
        },
      };
    },
  };
}

function descendants(el: StubEl): StubEl[] {
  const out: StubEl[] = [];
  for (const child of el.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

/** The list container this renderer builds (`<div class="chat-sessions-list">`). */
function findList(sidebar: StubEl): StubEl {
  const list = descendants(sidebar).find((el) => el.className === 'chat-sessions-list');
  if (!list) throw new Error('renderOperatorSessionsSidebar() rendered no .chat-sessions-list');
  return list;
}

function renderSidebar(threads: Array<Record<string, unknown>>, showArchived = false): StubEl {
  const src = functionBody(APP_JS, 'function renderOperatorSessionsSidebar() {');
  const state = {
    operatorThreads: threads,
    operatorSessionsSidebarCollapsed: false,
    operatorShowArchivedThreads: showArchived,
  };
  const rowStub = (thread: Record<string, unknown>): StubEl => {
    const el = stubDocument().createElement('div');
    el.className = 'chat-session-row';
    el.textContent = String(thread.id);
    return el;
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'state',
    'document',
    'renderOperatorThreadRow',
    'startNewOperatorThread',
    'renderApp',
    src + '\nreturn renderOperatorSessionsSidebar;',
  ) as (...args: unknown[]) => () => StubEl;

  const fn = make(state, stubDocument(), rowStub, () => undefined, () => undefined);
  return fn();
}

describe('VTID-04142: Operator Console thread list empty state', () => {
  it('renders "No conversations yet" in the list when there are no threads', () => {
    const sidebar = renderSidebar([]);
    const list = findList(sidebar);

    const empty = list.children.find((el) => el.className === 'chat-sessions-empty');
    expect(empty).toBeDefined();
    expect(empty!.textContent).toBe('No conversations yet');
  });

  it('renders no thread rows and no archived toggle when the list is genuinely empty', () => {
    const sidebar = renderSidebar([]);
    const list = findList(sidebar);

    expect(list.children.filter((el) => el.className.indexOf('chat-session-row') === 0)).toHaveLength(0);
    expect(descendants(sidebar).some((el) => el.className === 'chat-sessions-archived-toggle')).toBe(false);
    // The empty state is the ONLY child of the list — never a visually blank box.
    expect(list.children).toHaveLength(1);
  });

  it('still shows the empty state when every thread is archived (no ACTIVE threads left)', () => {
    const sidebar = renderSidebar([{ id: 'a1', title: 'Old chat', archived: true, updatedAt: 1 }]);
    const list = findList(sidebar);

    const empty = list.children.find((el) => el.className === 'chat-sessions-empty');
    expect(empty).toBeDefined();
    expect(empty!.textContent).toBe('No conversations yet');
    // ...and the archived thread stays reachable via its toggle.
    expect(descendants(sidebar).some((el) => el.className === 'chat-sessions-archived-toggle')).toBe(true);
  });

  it('does NOT render the empty state once at least one active thread exists, and lists it instead', () => {
    const sidebar = renderSidebar([
      { id: 'older', title: 'Older', updatedAt: 10 },
      { id: 'newer', title: 'Newer', updatedAt: 20 },
    ]);
    const list = findList(sidebar);

    expect(list.children.some((el) => el.className === 'chat-sessions-empty')).toBe(false);
    const rows = list.children.filter((el) => el.className === 'chat-session-row');
    // Most-recently-updated first.
    expect(rows.map((r) => r.textContent)).toEqual(['newer', 'older']);
  });

  it('the empty-state message is an explicit, non-empty string literal in app.js (not an empty container)', () => {
    const body = functionBody(APP_JS, 'function renderOperatorSessionsSidebar() {');
    expect(body).toContain("empty.className = 'chat-sessions-empty';");
    expect(body).toContain("empty.textContent = 'No conversations yet';");
    expect(body).toContain('list.appendChild(empty);');
    // The branch is keyed off the ACTIVE (non-archived) count.
    expect(body).toContain('if (activeThreads.length === 0) {');
  });

  it('ships the cache-bust bump (both links in sync) and the ownership-guard allowlist entry', () => {
    const styles = (INDEX_HTML.match(/styles\.css\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    const app = (INDEX_HTML.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(app).toBe(styles);
    expect(app >= '20260920-vtid-04142-operator-no-conversations-empty-state').toBe(true);
    expect(GUARD_JS).toMatch(/ALLOWED_VTID_PATTERN = \/[^\n]*VTID-04142/);
  });
});
