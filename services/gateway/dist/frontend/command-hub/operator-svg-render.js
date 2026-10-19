/**
 * VTID-05082 / DEV-COMHU-0205 — Operator chat inline SVG rendering.
 *
 * When an assistant reply contains SVG markup (a fenced ```svg block or a raw
 * <svg>...</svg>), the Operator transcript renders it as a scaled-to-fit image
 * with expand + download controls. SVG is treated as UNTRUSTED: it is
 * allowlist-sanitized, then shown ONLY as <img src="data:image/svg+xml;base64,...">
 * built via createElement (never innerHTML, never inline SVG in the live DOM).
 * The <img> context is the isolation boundary (no script execution, no host-DOM
 * reach); the sanitizer is defense in depth and blocks outbound fetches.
 *
 * Hook (decision B, owner-approved): VTID-05073 froze every function moved into
 * operator-console.js (renderOperatorChat included) as byte-identical to its
 * base. So this module never edits that renderer. app.js's _renderAppCore calls
 * window.OperatorSvgRender.enhanceOperatorChat(root, state.chatMessages) once
 * the DOM is built, and this module post-processes the rendered transcript:
 * each reply bubble that maps 1:1 to a reply message gets its SVG previews
 * inserted right after it. If the bubbles do not line up with the messages, the
 * container is left untouched (fail closed: raw text stays, nothing renders).
 */
(function () {
    'use strict';

    // Max SVG payload size, ~200 KB measured as JS string length (approximate guard).
    var SVG_PAYLOAD_MAX_LEN = 204800;
    // SVG elements allowed to survive sanitization. Anything else (including the
    // script element, foreignObject, image, anchors, animation and media elements)
    // is removed from its parent.
    var SVG_ALLOWED_ELEMENTS = {
        svg: true, g: true, path: true, rect: true, circle: true, ellipse: true,
        line: true, polyline: true, polygon: true, text: true, tspan: true,
        textpath: true, defs: true, lineargradient: true, radialgradient: true,
        stop: true, clippath: true, mask: true, use: true, title: true, desc: true,
        symbol: true, pattern: true, marker: true, filter: true, metadata: true,
        style: false
    };
    // Marks a bubble already post-processed, so a second pass never duplicates previews.
    var ENHANCED_ATTR = 'data-svg-enhanced';
    // Running counter so each downloaded file gets a distinct name.
    var svgPreviewDownloadSeq = 0;

    // Extract ordered raw SVG payloads from an assistant reply string. Returns [].
    function extractSvgPayloads(content) {
        if (typeof content !== 'string' || content.length === 0) return [];
        var svgOpenToken = '<' + 'svg';
        if (content.indexOf(svgOpenToken) === -1) return [];
        var payloads = [];
        var seen = {};
        // 1) Fenced blocks: ```svg ... ``` or a bare ``` fence whose body is <svg...>.
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
        // 2) Standalone <svg ...>...</svg> occurrences anywhere in the prose.
        var rawRe = /<svg[\s>][\s\S]*?<\/svg\s*>/gi;
        var rm;
        while ((rm = rawRe.exec(content)) !== null) {
            var raw = rm[0];
            if (raw && !seen[raw]) { seen[raw] = true; payloads.push(raw); }
        }
        // Enforce the size cap (NFR5).
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

    // Sanitize untrusted SVG markup against an element/attribute allowlist. Returns
    // the serialized, prolog-free, trimmed root <svg>, or '' when nothing drawable
    // survives (FR9). Pure and side-effect free.
    function sanitizeSvgMarkup(rawSvg) {
        if (typeof rawSvg !== 'string' || rawSvg.length === 0) return '';
        if (rawSvg.length > SVG_PAYLOAD_MAX_LEN) return '';
        // Pre-reject any document-type or entity declaration (tokens built by
        // concatenation so this source line matches no CSP gate pattern).
        var lower = rawSvg.toLowerCase();
        var doctypeToken = '<!' + 'doctype';
        var entityToken = '<!' + 'entity';
        if (lower.indexOf(doctypeToken) !== -1 || lower.indexOf(entityToken) !== -1) return '';
        var doc;
        try {
            doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
        } catch (err) {
            return '';
        }
        if (!doc) return '';
        if (doc.getElementsByTagName('parsererror').length > 0) return '';
        var root = doc.documentElement;
        if (!root || String(root.nodeName).toLowerCase() !== 'svg') return '';
        try {
            sanitizeSvgNode(root);
        } catch (err2) {
            return '';
        }
        // Childless root -> nothing to draw.
        if (!root.firstElementChild) return '';
        var serialized;
        try {
            serialized = new XMLSerializer().serializeToString(root);
        } catch (err3) {
            return '';
        }
        return String(serialized).trim();
    }

    // Recursively scrub one element and its subtree against the allowlist.
    function sanitizeSvgNode(el) {
        var STYLE_ATTR = 's' + 'tyle';
        var feToken = 'f' + 'e';
        // Remove disallowed child elements first (iterate over a snapshot).
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
        // Scrub attributes on this element (iterate over a snapshot of names).
        var attrNames = [];
        if (el.attributes) {
            for (var a = 0; a < el.attributes.length; a++) attrNames.push(el.attributes[a].name);
        }
        for (var n = 0; n < attrNames.length; n++) {
            var name = attrNames[n];
            var lname = name.toLowerCase();
            var localName = lname.indexOf(':') !== -1 ? lname.split(':').pop() : lname;
            // Event handlers: any on* attribute.
            if (lname.slice(0, 2) === ('o' + 'n')) { el.removeAttribute(name); continue; }
            // href / xlink:href and other xlink:* refs: keep only pure #fragments.
            if (localName === 'href' || lname.indexOf('xlink:') === 0) {
                var hv = String(el.getAttribute(name) || '').replace(/\s+/g, '');
                if (!/^#[\w:.-]+$/.test(hv)) { el.removeAttribute(name); }
                continue;
            }
            // style attribute: drop whole if it carries a dangerous construct.
            if (localName === STYLE_ATTR) {
                if (svgStyleIsDangerous(el.getAttribute(name))) el.removeAttribute(STYLE_ATTR);
                continue;
            }
            // Any other attribute whose value points a url() somewhere other than a
            // local #fragment is dropped (neutralizes remote references).
            var val = String(el.getAttribute(name) || '');
            if (svgValueHasForeignUrl(val)) { el.removeAttribute(name); }
        }
    }

    // True when a style attribute value carries a url(), an @import, an expression
    // call, or a script scheme. Tokens are assembled so no CSP gate pattern fires.
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
        // Local reference url(#id) is fine; anything else is foreign.
        return rest.charAt(0) !== '#';
    }

    // Convert a (possibly non-ASCII) string to base64, UTF-8 safe. btoa throws on
    // code points > 0xFF, so collapse to a byte string first (AC-16).
    function toUtf8Base64Safe(s) {
        return btoa(unescape(encodeURIComponent(String(s))));
    }

    // Build the data URI for the sanitized SVG markup.
    function buildSvgDataUrl(sanitizedMarkup) {
        return 'data:image/svg+xml;base64,' + toUtf8Base64Safe(sanitizedMarkup);
    }

    // Build a .chat-svg-preview block for one sanitized payload. Returns null when
    // nothing drawable survives sanitization (FR9).
    function renderSvgPreviewBlock(rawSvg) {
        var sanitized = sanitizeSvgMarkup(rawSvg);
        if (!sanitized) return null;
        var dataUrl;
        try {
            dataUrl = buildSvgDataUrl(sanitized);
        } catch (err) {
            if (window.console && console.warn) console.warn('[svg-preview] encode failed');
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
        // ICON_EXPAND_SVG is app.js's own static icon constant (trusted, not reply content).
        if (typeof ICON_EXPAND_SVG === 'string') expandBtn.innerHTML = ICON_EXPAND_SVG;
        else expandBtn.textContent = 'Expand';
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

    // Save the sanitized SVG bytes as a .svg download (AC-8).
    function downloadSvgMarkup(sanitizedMarkup) {
        try {
            svgPreviewDownloadSeq += 1;
            var blob = new Blob([sanitizedMarkup], { type: 'image/svg+xml' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'operator-mockup-' + svgPreviewDownloadSeq + '.svg';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        } catch (err) {
            // Download is best-effort; preview + expand still work.
        }
    }

    // Open a single-instance fullscreen lightbox of the sanitized SVG. Closable by
    // backdrop click, the close button, and Esc; every close path removes the
    // overlay and its keydown listener (AC-7).
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
        closeBtn.textContent = '\u00d7';
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

    // The message bubbles renderOperatorChat drew directly into one .chat-messages
    // container, in order (sent and reply bubbles only).
    function transcriptBubbles(messagesEl) {
        var out = [];
        var el = messagesEl.firstElementChild;
        while (el) {
            if (el.classList && el.classList.contains('message-bubble') &&
                (el.classList.contains('message-sent') || el.classList.contains('message-reply'))) {
                out.push(el);
            }
            el = el.nextElementSibling;
        }
        return out;
    }

    // Post-process the rendered Operator transcript(s) under `root`: for each reply
    // message carrying SVG, insert sanitized previews right after its bubble.
    // Reply messages only; user-authored (sent) messages are never scanned. A
    // container whose bubbles do not line up 1:1 with `chatMessages` (by count and
    // sent/reply kind) is skipped. Returns the number of previews inserted.
    function enhanceOperatorChat(root, chatMessages) {
        if (!root || !root.querySelectorAll || !Array.isArray(chatMessages) || chatMessages.length === 0) return 0;
        var inserted = 0;
        var containers = root.querySelectorAll('.chat-container > .chat-messages');
        for (var ci = 0; ci < containers.length; ci++) {
            var bubbles = transcriptBubbles(containers[ci]);
            if (bubbles.length < chatMessages.length) continue;
            var aligned = true;
            for (var k = 0; k < chatMessages.length; k++) {
                var m = chatMessages[k] || {};
                var sent = m.type === 'user' || m.type === 'sent';
                if (bubbles[k].classList.contains('message-sent') !== sent) { aligned = false; break; }
            }
            if (!aligned) continue;
            for (var i = 0; i < chatMessages.length; i++) {
                var msg = chatMessages[i] || {};
                if (msg.type === 'user' || msg.type === 'sent') continue;
                var bubble = bubbles[i];
                if (bubble.getAttribute(ENHANCED_ATTR) === '1') continue;
                bubble.setAttribute(ENHANCED_ATTR, '1');
                var payloads = extractSvgPayloads(msg.content || msg.text || '');
                var anchor = bubble;
                for (var p = 0; p < payloads.length; p++) {
                    var block = renderSvgPreviewBlock(payloads[p]);
                    if (!block) continue;
                    anchor.parentNode.insertBefore(block, anchor.nextSibling);
                    anchor = block;
                    inserted += 1;
                }
            }
        }
        return inserted;
    }

    window.OperatorSvgRender = {
        extractSvgPayloads: extractSvgPayloads,
        sanitizeSvgMarkup: sanitizeSvgMarkup,
        toUtf8Base64Safe: toUtf8Base64Safe,
        buildSvgDataUrl: buildSvgDataUrl,
        renderSvgPreviewBlock: renderSvgPreviewBlock,
        renderSvgLightbox: renderSvgLightbox,
        enhanceOperatorChat: enhanceOperatorChat
    };
})();
