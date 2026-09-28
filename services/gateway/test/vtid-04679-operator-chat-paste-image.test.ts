/**
 * VTID-04679 — Clipboard paste support for the Operator Console chat textarea.
 *
 * app.js is a plain script with no module exports (Command Hub frontend),
 * so this is a source-text regression guard — same pattern as
 * vtid-03906-08-operator-scroll-mic-fullscreen.test.ts.
 *
 * The paste event listener is added to the chat textarea inside
 * renderOperatorChat() after the existing onkeydown handler. It:
 *   1. Reads e.clipboardData.items looking for an item where
 *      item.kind === 'file' && item.type.startsWith('image/')
 *   2. If an image is found: calls e.preventDefault() so the raw data URL
 *      does not land in the text field, extracts the file via item.getAsFile(),
 *      and passes it to uploadOperatorFile(file, 'image').
 *   3. If no image is found: does nothing, so normal text paste still works.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/frontend/command-hub/app.js'),
  'utf8'
);

// Locate the renderOperatorChat function body — bounded by the next top-level
// function declaration so we don't accidentally match code elsewhere.
const RENDER_START = SOURCE.indexOf('function renderOperatorChat() {');
const RENDER_END   = SOURCE.indexOf('\nfunction parseSseFrames(', RENDER_START);

function renderOperatorChatBody(): string {
  expect(RENDER_START).toBeGreaterThan(-1);
  expect(RENDER_END).toBeGreaterThan(RENDER_START);
  return SOURCE.slice(RENDER_START, RENDER_END);
}

describe('VTID-04679: clipboard paste image support in Operator Console chat', () => {
  it('renderOperatorChat() registers a paste event listener on the textarea', () => {
    const body = renderOperatorChatBody();
    expect(body).toContain("textarea.addEventListener('paste'");
  });

  it('the paste handler reads e.clipboardData.items', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    expect(pasteIdx).toBeGreaterThan(-1);
    // Scope to the paste handler block only.
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    expect(handlerSlice).toContain('e.clipboardData');
    expect(handlerSlice).toContain('.items');
  });

  it('the paste handler checks item.kind === "file" and item.type.startsWith("image/")', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    expect(handlerSlice).toContain("item.kind === 'file'");
    expect(handlerSlice).toContain("item.type.startsWith('image/')");
  });

  it('the paste handler calls e.preventDefault() when an image is found', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    expect(handlerSlice).toContain('e.preventDefault()');
  });

  it('the paste handler calls item.getAsFile() to extract the image', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    expect(handlerSlice).toContain('item.getAsFile()');
  });

  it('the paste handler passes the file to uploadOperatorFile with kind "image"', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    expect(handlerSlice).toContain("uploadOperatorFile(file, 'image')");
  });

  it('the paste listener is added after the onkeydown handler, before onblur', () => {
    const body = renderOperatorChatBody();
    const keydownIdx = body.indexOf('textarea.onkeydown = ');
    const pasteIdx   = body.indexOf("textarea.addEventListener('paste'");
    const onblurIdx  = body.indexOf('textarea.onblur = ');
    expect(keydownIdx).toBeGreaterThan(-1);
    expect(pasteIdx).toBeGreaterThan(keydownIdx);
    expect(onblurIdx).toBeGreaterThan(pasteIdx);
  });

  it('the paste handler guards against a missing clipboardData.items (returns early)', () => {
    const body = renderOperatorChatBody();
    const pasteIdx = body.indexOf("textarea.addEventListener('paste'");
    const handlerSlice = body.slice(pasteIdx, pasteIdx + 600);
    // Guard: `const items = e.clipboardData && e.clipboardData.items; if (!items) return;`
    expect(handlerSlice).toMatch(/e\.clipboardData && e\.clipboardData\.items/);
    expect(handlerSlice).toContain('if (!items) return');
  });
});
