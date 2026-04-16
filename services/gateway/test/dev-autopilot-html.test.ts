/**
 * Tests for Developer Autopilot plan HTML renderer + sanitizer.
 *
 * Plan content is LLM-generated — tests lock in that common markdown renders
 * cleanly and that the sanitizer strips dangerous tags/attributes even if the
 * LLM ever hallucinates raw HTML.
 */

import { renderPlanHtml } from '../src/services/dev-autopilot-html';

describe('renderPlanHtml', () => {
  it('returns empty string on empty input', () => {
    expect(renderPlanHtml('')).toBe('');
  });

  it('renders headings, lists, and code', () => {
    const md = `## Context\n\nSome **bold** text.\n\n- item one\n- item two\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
    const html = renderPlanHtml(md);
    expect(html).toContain('<h2>Context</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>item one</li>');
    expect(html).toContain('<code');
  });

  it('renders tables', () => {
    const md = `| a | b |\n|---|---|\n| 1 | 2 |`;
    const html = renderPlanHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('strips script tags even when markdown would pass them through', () => {
    const md = `# Hi\n\n<script>alert('x')</script>\n\nnormal text`;
    const html = renderPlanHtml(md);
    expect(html).not.toContain('<script');
    expect(html).not.toContain("alert('x')");
  });

  it('strips inline event handlers', () => {
    const md = `<a href="#" onclick="steal()">click</a>`;
    const html = renderPlanHtml(md);
    expect(html).not.toContain('onclick');
  });

  it('forces target=_blank and rel=noopener on links', () => {
    const md = `[click](https://example.com)`;
    const html = renderPlanHtml(md);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('blocks javascript: URLs', () => {
    const md = `[x](javascript:alert(1))`;
    const html = renderPlanHtml(md);
    expect(html).not.toContain('javascript:');
  });

  it('strips inline style attributes', () => {
    const md = `<p style="color:red">Hi</p>`;
    const html = renderPlanHtml(md);
    expect(html).not.toContain('style=');
  });
});
