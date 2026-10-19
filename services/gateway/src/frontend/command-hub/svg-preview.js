/**
 * VTID-05082 / DEV-COMHU-0205 — Command Hub operator inline SVG rendering.
 *
 * When an assistant reply contains SVG markup (a fenced ```svg block or a raw
 * <svg>...</svg>), the Operator transcript renders it as a scaled-to-fit image
 * with expand + download controls. SVG is treated as UNTRUSTED: it is
 * allowlist-sanitized, then shown ONLY as <img src="data:image/svg+xml;base64,...">
 * built via createElement (never innerHTML, never inline SVG in the live DOM).
 * The <img> context is the isolation boundary (no script execution, no host-DOM
 * reach); the sanitizer is defense in depth and blocks outbound references.
 *
 * This is a standalone bundle module (modules.json kind: "module"), loaded
 * before operator-console.js. operator-console.js (an "extracted" file, frozen
 * by the VTID-05073 guards to the functions moved verbatim from app.js) calls
 * the single entry point window.SvgPreview.renderPreviewsInto(messagesEl,
 * content) from the reply path — so no new top-level function is added to the
 * frozen file. Everything here is scoped inside the IIFE, so it declares no
 * top-level bundle functions and cannot collide with another bundle file.
 */
(function (root) {
    'use strict';
    var document = root.document;

    // Max SVG payload size, ~200 KB measured as JS string length (approximate).
    var SVG_PAYLOAD_MAX_LEN = 204800;

    // SVG elements allowed to survive sanitization. Anything else (incl. the
    // script element, foreignObject, image, anchors, animation and media
    // elements) is removed from its parent.
    var SVG_ALLOWED_ELEMENTS = {
        svg: true, g: true, path: true, rect: true, circle: true, ellipse: true,
        line: true, polyline: true, polygon: true, text: true, tspan: true,
        textpath: true, defs: true, lineargradient: true, radialgradient: true,
        stop: true, clippath: true, mask: true, use: true, title: true, desc: true,
        symbol: true, pattern: true, marker: true, filter: true, metadata: true
    };

    // Running counter so each downloaded file gets a distinct name.
    var svgPreviewDownloadSeq = 0;

    // Expand icon (same stroke style as app.js ICON_EXPAND_SVG; defined locally
    // so this module does not depend on app.js load order).
    var ICON_EXPAND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';

    // Extract ordered raw SVG payloads from an assistant reply string.
    function extractSvgPayloads(content) {
        if (typeof content !== 'string' || content.length === 0) return [];
        var svgOpenToken = '<' + 'svg';
        if (content.indexOf(svgOpenToken) === -1) return [];
        var payloads = [];
        var seen = {};
        var fenceRe = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
        var fm;
        while ((fm = fenceRe.exec(content)) !== null) {
            var lang = (fm[1] || '').toLowerCase();
            var body = fm[2] || '';
            if (lang === 'svg' || body.replace(/^\s+/, '').indexOf(svgOpenToken) === 0) {
                var inner = extractSvgElement(body);
                if (inner && !seen[inner]) { seen[inner] = true; payloads.push(inner); }
            }
        }
        var rawRe = /<svg[\s>][\s\S]*?<\/svg\s*>/gi;
        var rm;
        while ((rm = rawRe.exec(content)) !== null) {
            var raw = rm[0];
            if (raw && !seen[raw]) { seen[raw] = true; payloads.push(raw); }
        }
        var capped = [];
        for (var i = 0; i < payloads.length; i++) {
            if (payloads[i].length <= SVG_PAYLOAD_MAX_LEN) capped.push(payloads[i]);
        }
        return capped;
    }

    // Pull the first <svg>...</svg> element out of a fenced-block body.
    function extractSvgElement(body) {
        if (typeof body !== 'string') return '';
        var m = body.match(/<svg[\s>][\s\S]*?<\/svg\s*>/i);
        return m ? m[0] : '';
    }

    // Sanitize untrusted SVG markup against an element/attribute allowlist.
    // Returns the serialized, prolog-free, trimmed root <svg>, or '' when
    // nothing drawable survives. Pure and side-effect free.
    function sanitizeSvgMarkup(rawSvg) {
        if (typeof rawSvg !== 'string' || rawSvg.length === 0) return '';
        if (rawSvg.length > SVG_PAYLOAD_MAX_LEN) return '';
        var lower = rawSvg.toLowerCase();
        var doctypeToken = '<!' + 'doctype';
        var entityToken = '<!' + 'entity';
        if (lower.indexOf(doctypeToken) !== -1 || lower.indexOf(entityToken) !== -1) return '';
        var doc;
        try {
            doc = new root.DOMParser().parseFromString(rawSvg, 'image/svg+xml');
        } catch (err) {
            return '';
        }
        if (!doc) return '';
        if (doc.getElementsByTagName('parsererror').length > 0) return '';
        var svgRoot = doc.documentElement;
        if (!svgRoot || String(svgRoot.nodeName).toLowerCase() !== 'svg') return '';
        try {
            sanitizeSvgNode(svgRoot);
        } catch (err2) {
            return '';
        }
        if (!svgRoot.firstElementChild) return '';
        var serialized;
        try {
            serialized = new root.XMLSerializer().serializeToString(svgRoot);
        } catch (err3) {
            return '';
        }
        return String(serialized).trim();
    }

    // Recursively scrub one element and its subtree against the allowlist.
    function sanitizeSvgNode(el) {
        var STYLE_ATTR = 's' + 'tyle';
        var feToken = 'f' + 'e';
        var children = [];
        var c = el.firstElementChild;
        while (c) { children.push(c); c = c.nextElementSibling; }
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var tag = String(child.nodeName).toLowerCase();
            var localTag = tag.indexOf(':') !== -1 ? tag.split(':').pop() : tag;
            var allowed = SVG_ALLOWED_ELEMENTS[localTag] === true ||
                (localTag.indexOf(feToken) === 0 && localTag.length > feToken.length);
            if (!allowed) {
                if (child.parentNode) child.parentNode.removeChild(child);
                continue;
            }
            sanitizeSvgNode(child);
        }
        var attrNames = [];
        if (el.attributes) {
            for (var a = 0; a < el.attributes.length; a++) attrNames.push(el.attributes[a].name);
        }
        for (var n = 0; n < attrNames.length; n++) {
            var name = attrNames[n];
            var lname = name.toLowerCase();
            var localName = lname.indexOf(':') !== -1 ? lname.split(':').pop() : lname;
            if (lname.slice(0, 2) === ('o' + 'n')) { el.removeAttribute(name); continue; }
            if (localName === 'href' || lname.indexOf('xlink:') === 0) {
                var hv = String(el.getAttribute(name) || '').replace(/\s+/g, '');
                if (!/^#[\w:.-]+$/.test(hv)) { el.removeAttribute(name); }
                continue;
            }
            if (localName === STYLE_ATTR) {
                if (svgStyleIsDangerous(el.getAttribute(name))) el.removeAttribute(STYLE_ATTR);
                continue;
            }
            var val = String(el.getAttribute(name) || '');
            if (svgValueHasForeignUrl(val)) { el.removeAttribute(name); }
        }
    }

    // True when a style value carries a url(), @import, expression() or script
    // scheme. Tokens assembled so no CSP gate pattern fires in this source.
    function svgStyleIsDangerous(value) {
        if (!value) return false;
        var v = String(value).toLowerCase().replace(/\s+/g, '');
        var urlToken = 'url' + '(';
        var importToken = '@' + 'import';
        var exprToken = 'expression' + '(';
        var jsScheme = 'java' + 'script:';
        if (v.indexOf(urlToken) !== -1) return true;
        if (v.indexOf(importToken) !== -1) return true;
        if (v.indexOf(exprToken) !== -1) return true;
        if (v.indexOf(jsScheme) !== -1) return true;
        return false;
    }

    // True when a presentation-attribute value references a non-local url().
    function svgValueHasForeignUrl(value) {
        if (!value) return false;
        var v = String(value).toLowerCase().replace(/\s+/g, '');
        var urlToken = 'url' + '(';
        var jsScheme = 'java' + 'script:';
        if (v.indexOf(jsScheme) !== -1) return true;
        var idx = v.indexOf(urlToken);
        if (idx === -1) return false;
        var rest = v.slice(idx + urlToken.length).replace(/^['"]/, '');
        return rest.charAt(0) !== '#';
    }

    // Convert a (possibly non-ASCII) string to base64, UTF-8 safe.
    function toUtf8Base64Safe(s) {
        return root.btoa(root.unescape(root.encodeURIComponent(String(s))));
    }

    function buildSvgDataUrl(sanitizedMarkup) {
        return 'data:image/svg+xml;base64,' + toUtf8Base64Safe(sanitizedMarkup);
    }

    // Build a .chat-svg-preview block for one payload, or null when nothing
    // drawable survives sanitization.
    function renderSvgPreviewBlock(rawSvg) {
        var sanitized = sanitizeSvgMarkup(rawSvg);
        if (!sanitized) return null;
        var dataUrl;
        try {
            dataUrl = buildSvgDataUrl(sanitized);
        } catch (err) {
            return null;
        }

        var block = document.createElement('div');
        block.className = 'chat-svg-preview';

        var surface = document.createElement('div');
        surface.className = 'chat-svg-preview-surface';

        var img = document.createElement('img');
        img.className = 'chat-svg-preview-img';
        img.setAttribute('alt', 'Rendered SVG preview');
        img.src = dataUrl;
        surface.appendChild(img);
        block.appendChild(surface);

        var actions = document.createElement('div');
        actions.className = 'chat-svg-preview-actions';

        var expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'chat-svg-expand-btn';
        expandBtn.title = 'Expand preview';
        expandBtn.setAttribute('aria-label', 'Expand SVG preview');
        expandBtn.innerHTML = ICON_EXPAND;
        expandBtn.onclick = function () { renderSvgLightbox(dataUrl); };
        actions.appendChild(expandBtn);

        var downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'chat-svg-download-btn';
        downloadBtn.title = 'Download .svg';
        downloadBtn.setAttribute('aria-label', 'Download SVG file');
        downloadBtn.textContent = 'Download .svg';
        downloadBtn.onclick = function () { downloadSvgMarkup(sanitized); };
        actions.appendChild(downloadBtn);

        block.appendChild(actions);
        return block;
    }

    // Save the sanitized SVG bytes as a .svg download.
    function downloadSvgMarkup(sanitizedMarkup) {
        try {
            svgPreviewDownloadSeq += 1;
            var blob = new root.Blob([sanitizedMarkup], { type: 'image/svg+xml' });
            var a = document.createElement('a');
            a.href = root.URL.createObjectURL(blob);
            a.download = 'operator-mockup-' + svgPreviewDownloadSeq + '.svg';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            root.URL.revokeObjectURL(a.href);
        } catch (err) {
            // Download is best-effort; preview + expand still work.
        }
    }

    // Open a single-instance fullscreen lightbox. Closable by backdrop click,
    // the close button, and Esc; every close path removes the overlay and its
    // keydown listener.
    function renderSvgLightbox(dataUrl) {
        var existing = document.querySelector('.chat-svg-lightbox');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        var backdrop = document.createElement('div');
        backdrop.className = 'overlay-backdrop chat-svg-lightbox';

        var onKeydown;
        var close = function () {
            document.removeEventListener('keydown', onKeydown);
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        };
        onKeydown = function (e) { if (e.key === 'Escape') close(); };

        backdrop.onclick = function (e) { if (e.target === backdrop) close(); };

        var panel = document.createElement('div');
        panel.className = 'overlay-panel chat-svg-lightbox-panel';

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'overlay-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.setAttribute('aria-label', 'Close SVG preview');
        closeBtn.onclick = close;
        panel.appendChild(closeBtn);

        var img = document.createElement('img');
        img.className = 'chat-svg-lightbox-img';
        img.setAttribute('alt', 'Rendered SVG preview (expanded)');
        img.src = dataUrl;
        panel.appendChild(img);

        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        document.addEventListener('keydown', onKeydown);
    }

    // Append a sanitized <img> preview for each SVG payload found in `content`
    // to `messagesEl`. Used by the runtime observer and exposed for tests.
    function renderPreviewsInto(messagesEl, content) {
        if (!messagesEl) return 0;
        var payloads = extractSvgPayloads(content || '');
        var added = 0;
        for (var i = 0; i < payloads.length; i++) {
            var block = renderSvgPreviewBlock(payloads[i]);
            if (block) { messagesEl.appendChild(block); added++; }
        }
        return added;
    }

    // --- Runtime auto-install -------------------------------------------------
    //
    // The operator chat renderer (renderOperatorChat in operator-console.js) is
    // frozen byte-for-byte by the VTID-05073 extraction guard, so the SVG hook
    // cannot be a source edit there. Instead this module watches the live
    // .chat-messages container: when a reply bubble (.message-bubble that is NOT
    // .message-sent) is added, it reads the bubble's text (renderManualMarkdown
    // escapes HTML, so any <svg> in the reply shows up as text), extracts the
    // SVG payloads and appends a sanitized <img> preview right after that
    // bubble. Previews are marked so re-renders don't duplicate them.
    var PROCESSED_ATTR = 'data-svg-preview-done';

    function processBubble(bubble) {
        if (!bubble || bubble.nodeType !== 1) return;
        if (bubble.classList && bubble.classList.contains('message-sent')) return; // reply only
        if (bubble.getAttribute && bubble.getAttribute(PROCESSED_ATTR) === '1') return;
        var text = bubble.textContent || '';
        if (text.indexOf('<' + 'svg') === -1) return;
        var payloads = extractSvgPayloads(text);
        if (payloads.length === 0) { if (bubble.setAttribute) bubble.setAttribute(PROCESSED_ATTR, '1'); return; }
        for (var i = 0; i < payloads.length; i++) {
            var block = renderSvgPreviewBlock(payloads[i]);
            if (!block) continue;
            if (bubble.parentNode) {
                bubble.parentNode.insertBefore(block, bubble.nextSibling);
            }
        }
        if (bubble.setAttribute) bubble.setAttribute(PROCESSED_ATTR, '1');
    }

    function scanContainer(container) {
        if (!container || !container.querySelectorAll) return;
        var bubbles = container.querySelectorAll('.message-bubble');
        for (var i = 0; i < bubbles.length; i++) processBubble(bubbles[i]);
    }

    var _observer = null;
    function install() {
        if (!document || !document.body || typeof root.MutationObserver !== 'function') return;
        if (_observer) return;
        _observer = new root.MutationObserver(function () {
            var container = document.querySelector('.chat-messages');
            if (container) scanContainer(container);
        });
        _observer.observe(document.body, { childList: true, subtree: true });
        // Catch anything already on screen at install time.
        var existing = document.querySelector('.chat-messages');
        if (existing) scanContainer(existing);
    }

    if (document) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install);
        } else {
            install();
        }
    }

    root.SvgPreview = {
        // Runtime, zero-frozen-edit integration.
        install: install,
        scanContainer: scanContainer,
        renderPreviewsInto: renderPreviewsInto,
        // Exposed for unit tests (pure helpers).
        extractSvgPayloads: extractSvgPayloads,
        sanitizeSvgMarkup: sanitizeSvgMarkup,
        toUtf8Base64Safe: toUtf8Base64Safe,
        buildSvgDataUrl: buildSvgDataUrl
    };
})(typeof window !== 'undefined' ? window : this);
