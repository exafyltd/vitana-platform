/**
 * Developer Autopilot — server-side markdown renderer + sanitizer
 *
 * Plans are LLM-generated markdown. We render to HTML server-side and store
 * the sanitized result in `dev_autopilot_plan_versions.plan_html` so the
 * Command Hub frontend can just innerHTML the safe_html blob without pulling
 * in a client-side markdown renderer.
 *
 * Security model:
 *   - Allow only a safe subset of tags needed for plan content
 *   - Strip all inline styles, event handlers, and scripts
 *   - Force links to open externally with rel=noopener
 *   - No raw HTML — marked is configured not to preserve it; sanitize-html
 *     is the belt to marked's suspenders
 */

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const LOG_PREFIX = '[dev-autopilot-html]';

marked.setOptions({
  gfm: true,
  breaks: false,
});

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'em', 'del', 'code', 'pre',
    'blockquote',
    'ul', 'ol', 'li',
    'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target', 'title'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
  },
};

export function renderPlanHtml(markdown: string): string {
  if (!markdown) return '';
  try {
    const raw = marked.parse(markdown, { async: false }) as string;
    return sanitizeHtml(raw, SANITIZE_OPTIONS);
  } catch (err) {
    console.error(`${LOG_PREFIX} render failed:`, err);
    return '<p><em>Plan render failed.</em></p>';
  }
}

export { LOG_PREFIX };
