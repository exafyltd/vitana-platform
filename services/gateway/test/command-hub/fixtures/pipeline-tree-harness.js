/* VTID-05069 harness only: renders fixture views with the real pipeline-tree.js renderer.
   window.__PT_VIEWS__ ({ "1": view, "2": view, "3": view }) and window.__PT_NOW__ are set
   by capture-pipeline-tree.ts before the page loads; ?state=1|2|3 picks the view. */
(function () {
  'use strict';
  var views = window.__PT_VIEWS__ || {};
  var now = window.__PT_NOW__ || Date.now();
  var key = new URLSearchParams(window.location.search).get('state') || '1';
  var v = views[key];
  var app = document.getElementById('app');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  var side = el('aside', 'h-side');
  side.appendChild(el('h4', '', 'Operator threads'));
  [['running', 'Operator activity spinner', key === '1'], ['failed', 'Copy-paste images', key !== '1'], ['done', 'hello, are you there', false]].forEach(function (t) {
    var row = el('div', 'h-th' + (t[2] ? ' h-th--active' : ''));
    var status = t[0] === 'failed' && key === '3' ? 'waiting' : t[0] === 'failed' && key === '2' ? 'running' : t[0];
    var dot = el('span', 'pt-thread-dot pt-thread-dot--' + status);
    row.appendChild(el('span', 'h-th-t', t[1]));
    row.appendChild(dot);
    side.appendChild(row);
  });
  app.appendChild(side);

  var main = el('main', 'h-main');
  if (key === '1') {
    main.appendChild(el('div', 'h-user', 'i want to see visually that a process is going on in the background'));
    var who = el('div', 'h-who');
    who.appendChild(el('span', 'h-av', 'K'));
    who.appendChild(el('span', '', 'Kiro'));
    main.appendChild(who);
  }
  var runs = el('div', 'pt-runs');
  runs.appendChild(window.PipelineTree.renderCard(v, {
    doc: document,
    now: now,
    live: true,
    updatedAt: now - 2000,
    state: { nodes: {}, showCommits: key === '3', note: '' }
  }));
  main.appendChild(runs);
  main.appendChild(el('div', 'h-composer', 'Ask Kiro… (the run keeps going if you switch threads)'));
  app.appendChild(main);
})();
