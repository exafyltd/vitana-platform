/**
 * A0.1 — Characterization test for executeLiveApiToolInner dispatcher.
 *
 * This is a *structural* characterization, not a runtime one. The dispatcher
 * does early-returns for navigator tools, then runs an auth gate, then
 * dispatches the remaining tools through a long chain of `if (toolName === X)`
 * branches that internally call DB-bound handlers (Supabase, RPCs).
 *
 * Mocking that whole tree for a runtime shell would multiply the size of this
 * PR. Instead we lock the dispatcher's contract by parsing the source file
 * itself and asserting the routing structure: tool name X must dispatch to
 * a known handler, and the early-return order for navigator tools must be
 * preserved.
 *
 * This is the kind of test that catches real regressions in step A6 (the
 * tool-execution split). When A6 turns the if-chain into
 * `dispatcher.lookup(toolName).handle(...)`, this test should be replaced
 * with a runtime test against the new dispatcher that asserts the same
 * routing. Until then, structural assertion is the cheapest insurance.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');

let source: string;
let dispatcherBody: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  // Slice the file from the dispatcher's signature down. We don't try to find
  // its exact closing brace — a substring is enough for "appears before
  // post-auth handler X" assertions.
  const dispatcherStart = source.indexOf('async function executeLiveApiToolInner(');
  expect(dispatcherStart).toBeGreaterThan(0);
  dispatcherBody = source.slice(dispatcherStart);
});

describe('A0.1 characterization: executeLiveApiToolInner dispatcher contract', () => {
  describe('top-5 tools surface (must remain reachable through the dispatcher)', () => {
    // These are the five tool names the refactor must preserve as
    // dispatchable. Picked to cover both code-paths (pre-auth navigator
    // tools and post-auth domain tools) so the "shell" represents both
    // future handler buckets in step A6.
    const TOP_5_TOOLS = [
      'get_current_screen',  // navigator, pre-auth path
      'navigate',            // navigator, pre-auth path
      'navigate_to_screen',  // navigator, pre-auth path
      'search_memory',       // memory domain, post-auth
      'save_diary_entry',    // diary domain, post-auth
    ];

    it.each(TOP_5_TOOLS)('dispatcher recognises tool name "%s"', (toolName) => {
      expect(dispatcherBody).toContain(`'${toolName}'`);
    });

    it.each(TOP_5_TOOLS)('"%s" appears as an if-branch OR a switch-case keyed by toolName', (toolName) => {
      // The dispatcher uses two patterns: pre-auth navigator tools live in
      //   `if (toolName === '<name>')` branches,
      // post-auth tools live in
      //   `case '<name>':` arms of a `switch (toolName)` block.
      // Either form is a valid contract anchor. A6 may unify both into a
      // single dispatch table, but until then we accept both.
      const ifBranch = new RegExp(`if\\s*\\(\\s*toolName\\s*===?\\s*['"\`]${toolName}['"\`]\\s*\\)`);
      const caseArm = new RegExp(`case\\s+['"\`]${toolName}['"\`]\\s*:`);
      const matchesIfBranch = ifBranch.test(dispatcherBody);
      const matchesCaseArm = caseArm.test(dispatcherBody);
      expect(matchesIfBranch || matchesCaseArm).toBe(true);
    });
  });

  describe('navigator early-return ordering (pre-auth path)', () => {
    // The dispatcher comments make it explicit: navigator tools must be
    // handled BEFORE the auth/identity gate so anonymous onboarding
    // sessions can navigate. A6 must preserve this ordering.
    const navigatorTools = ['get_current_screen', 'navigate', 'navigate_to_screen'];

    it.each(navigatorTools)('"%s" routes to its dedicated handler', (toolName) => {
      // Each navigator tool is handled by `handle<PascalCase>(session ...)`
      const handlerName = 'handle' + toolName
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
      expect(dispatcherBody).toContain(handlerName);
    });

    it('navigator tools are dispatched before the auth gate', () => {
      // The auth gate is the explicit comment + identity check at the end
      // of the pre-auth block:
      //   `// Validate identity for tool execution (everything below requires auth)`
      // All three navigator tools must appear earlier than this marker.
      const indices = navigatorTools.map((name) => dispatcherBody.indexOf(`'${name}'`));
      expect(indices.every((i) => i > 0)).toBe(true);

      const authGateMarker = dispatcherBody.indexOf('Validate identity for tool execution');
      expect(authGateMarker).toBeGreaterThan(0);
      for (const i of indices) {
        expect(i).toBeLessThan(authGateMarker);
      }
    });
  });

  describe('handler reachability (post-auth tools call into named handlers)', () => {
    // Light-touch: every post-auth tool should have a corresponding case
    // body that does *something* identifiable. We don't lock the full body
    // — that would lock implementation. We only assert the case keys exist.
    const POST_AUTH_TOOLS = ['search_memory', 'save_diary_entry'];

    it.each(POST_AUTH_TOOLS)('"%s" has a case body in the dispatcher', (toolName) => {
      // After step A6 the file structure changes (switch → handler module).
      // For now we assert that the tool name appears alongside a case/return
      // pattern within the dispatcher body.
      const idx = dispatcherBody.indexOf(`'${toolName}'`);
      expect(idx).toBeGreaterThan(0);
      // Within ~4000 chars after the toolName mention, expect a `return`
      // (every dispatch branch returns its result envelope).
      const window = dispatcherBody.slice(idx, idx + 4000);
      expect(window).toMatch(/\breturn\b/);
    });
  });
});
