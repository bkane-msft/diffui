'use strict';

// ---- small helpers -------------------------------------------------------
function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function esc(s) {
  return s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

async function api(pathname, opts) {
  const res = await fetch(pathname, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

const STATUS_LABEL = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', T: 'M' };

// ---- unified diff parsing -----------------------------------------------
function parseDiff(text) {
  const rows = [];
  let oldLn = 0;
  let newLn = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('dissimilarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('copy ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
      if (m) {
        oldLn = parseInt(m[1], 10);
        newLn = parseInt(m[2], 10);
        rows.push({ type: 'hunk', text: line });
      }
      continue;
    }
    if (line.startsWith('\\')) {
      rows.push({ type: 'meta', text: line });
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === '+') rows.push({ type: 'add', newLn: newLn++, text: body });
    else if (sign === '-') rows.push({ type: 'del', oldLn: oldLn++, text: body });
    else rows.push({ type: 'ctx', oldLn: oldLn++, newLn: newLn++, text: body });
  }
  return rows;
}

function renderDiffTable(text) {
  const rows = parseDiff(text);
  if (rows.length === 0) return h('div', { class: 'nochange' }, 'No textual changes.');
  const tbody = h('tbody');
  for (const r of rows) {
    if (r.type === 'hunk') {
      tbody.appendChild(
        h('tr', { class: 'row-hunk' }, [h('td', { colspan: '3', html: esc(r.text) })])
      );
      continue;
    }
    if (r.type === 'meta') {
      tbody.appendChild(
        h('tr', { class: 'row-meta' }, [
          h('td', { class: 'ln' }, ''),
          h('td', { class: 'ln' }, ''),
          h('td', { class: 'code', html: '<span class="ro-note">' + esc(r.text) + '</span>' }),
        ])
      );
      continue;
    }
    const cls = r.type === 'add' ? 'row-add' : r.type === 'del' ? 'row-del' : 'row-ctx';
    const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
    tbody.appendChild(
      h('tr', { class: cls }, [
        h('td', { class: 'ln' }, r.oldLn != null ? String(r.oldLn) : ''),
        h('td', { class: 'ln' }, r.newLn != null ? String(r.newLn) : ''),
        h('td', { class: 'code', html: '<span class="sign">' + sign + '</span>' + esc(r.text) }),
      ])
    );
  }
  return h('table', { class: 'diff-table' }, [tbody]);
}

// ---- app state -----------------------------------------------------------
const App = {
  session: null,
};

async function loadSession() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(h('div', { class: 'empty' }, 'Loading diff\u2026'));
  try {
    App.session = await api('/api/session');
  } catch (e) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'banner' }, 'Failed to load: ' + e.message));
    return;
  }
  render();
}

function render() {
  const s = App.session;
  document.getElementById('diffLabel').textContent = s.label.text + (s.editable ? '  \u270e editable' : '  \u25cf read-only');

  // sidebar
  const list = document.getElementById('filelist');
  list.innerHTML = '';
  let addT = 0;
  let delT = 0;
  for (const f of s.files) {
    addT += f.additions;
    delT += f.deletions;
    const li = h('li', { 'data-path': f.path, onclick: () => scrollToFile(f.path) }, [
      h('span', { class: 'status-badge st-' + (STATUS_LABEL[f.status] || 'M') }, STATUS_LABEL[f.status] || 'M'),
      h('span', { class: 'fname', title: f.path }, f.path),
      h('span', { class: 'counts' }, [
        h('span', { class: 'add' }, '+' + f.additions),
        ' ',
        h('span', { class: 'del' }, '\u2212' + f.deletions),
      ]),
    ]);
    list.appendChild(li);
  }
  document.getElementById('fileCount').textContent =
    s.files.length + (s.files.length === 1 ? ' file' : ' files');
  document.getElementById('totals').innerHTML =
    '<span class="add" style="color:var(--add-text)">+' + addT + '</span> ' +
    '<span class="del" style="color:var(--del-text)">\u2212' + delT + '</span>';

  // main
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (s.error) {
    content.appendChild(h('div', { class: 'banner' }, s.error));
    return;
  }
  if (s.files.length === 0) {
    content.appendChild(h('div', { class: 'empty' }, 'No changes for ' + s.label.text + '.'));
    return;
  }
  for (const f of s.files) content.appendChild(renderFileCard(f));
}

function fileCardId(p) {
  return 'file-' + p.replace(/[^a-zA-Z0-9]/g, '_');
}

function scrollToFile(p) {
  const el = document.getElementById(fileCardId(p));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.filelist li').forEach((li) => {
    li.classList.toggle('active', li.getAttribute('data-path') === p);
  });
}

function renderFileCard(f) {
  const s = App.session;
  const canEdit = s.editable && !f.binary && f.status !== 'D';
  const body = h('div', { class: 'filecard-body' }, [h('div', { class: 'empty' }, 'Loading\u2026')]);

  const head = h('div', { class: 'filecard-head' }, [
    h('span', { class: 'status-badge st-' + (STATUS_LABEL[f.status] || 'M') }, STATUS_LABEL[f.status] || 'M'),
    h('span', { class: 'path', title: f.path }, f.oldPath ? f.oldPath + ' \u2192 ' + f.path : f.path),
    h('span', { class: 'grow' }),
    h('span', { class: 'counts', html: '<span class="add" style="color:var(--add-text)">+' + f.additions + '</span> <span class="del" style="color:var(--del-text)">\u2212' + f.deletions + '</span>' }),
    canEdit ? h('button', { class: 'btn small', onclick: () => enterEdit(f, body) }, 'Edit') : null,
  ]);

  const card = h('div', { class: 'filecard', id: fileCardId(f.path) }, [head, body]);

  if (f.binary) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'binary' }, 'Binary file \u2014 not shown.'));
    return card;
  }

  // lazy-load the diff
  api('/api/diff?path=' + encodeURIComponent(f.path))
    .then((d) => {
      body.innerHTML = '';
      body.appendChild(renderDiffTable(d.diff));
    })
    .catch((e) => {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'banner' }, e.message));
    });

  return card;
}

async function enterEdit(f, body) {
  body.innerHTML = '';
  body.appendChild(h('div', { class: 'empty' }, 'Loading file\u2026'));
  let content;
  try {
    const data = await api('/api/file?path=' + encodeURIComponent(f.path));
    content = data.content;
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'banner' }, e.message));
    return;
  }

  const ta = h('textarea', { class: 'editor', spellcheck: 'false' });
  ta.value = content;
  const save = async () => {
    try {
      const res = await api('/api/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: f.path, content: ta.value }),
      });
      f.additions = res.additions;
      f.deletions = res.deletions;
      toast('Saved ' + f.path);
      // refresh sidebar counts + re-render this card's diff
      render();
      scrollToFile(f.path);
    } catch (e) {
      toast('Save failed: ' + e.message);
    }
  };
  ta.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
      ev.preventDefault();
      save();
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
    }
  });

  const bar = h('div', { class: 'editor-bar' }, [
    h('span', { class: 'hint' }, 'Editing working file \u2014 \u2318S / Ctrl+S to save. Writes straight to disk.'),
    h('button', { class: 'btn small', onclick: () => reloadCard(f, body) }, 'Cancel'),
    h('button', { class: 'btn small primary', onclick: save }, 'Save'),
  ]);

  body.innerHTML = '';
  body.appendChild(h('div', { class: 'editor-wrap' }, [ta, bar]));
  ta.focus();
}

function reloadCard(f, body) {
  body.innerHTML = '';
  body.appendChild(h('div', { class: 'empty' }, 'Loading\u2026'));
  api('/api/diff?path=' + encodeURIComponent(f.path))
    .then((d) => {
      body.innerHTML = '';
      body.appendChild(renderDiffTable(d.diff));
    })
    .catch((e) => {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'banner' }, e.message));
    });
}

// ---- modals --------------------------------------------------------------
function openModal(node) {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('modal');
  modal.innerHTML = '';
  modal.appendChild(node);
  backdrop.hidden = false;
}
function closeModal() {
  document.getElementById('modalBackdrop').hidden = true;
}
document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});

async function switchSpec(spec) {
  try {
    App.session = await api('/api/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    closeModal();
    render();
  } catch (e) {
    toast(e.message);
  }
}

function openCompare() {
  const base = h('input', { placeholder: 'e.g. HEAD~3 or main', value: '' });
  const target = h('input', { placeholder: 'blank = working tree, or a commit', value: '' });
  const node = h('div', {}, [
    h('h2', {}, 'Compare revisions'),
    h('div', { class: 'hint' }, 'Leave target blank to diff a commit against your working tree (editable). Set both for a historical, read-only diff.'),
    h('div', { class: 'field' }, [h('label', {}, 'Base'), base]),
    h('div', { class: 'field' }, [h('label', {}, 'Target (optional)'), target]),
    h('div', { class: 'row' }, [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const b = base.value.trim();
          const t = target.value.trim();
          if (!b) { toast('Enter a base revision'); return; }
          switchSpec(t ? [b, t] : [b]);
        },
      }, 'Show diff'),
    ]),
  ]);
  openModal(node);
  base.focus();
}

async function openHistory() {
  let data;
  try {
    data = await api('/api/history');
  } catch (e) {
    toast(e.message);
    return;
  }
  const items = data.entries.map((e) =>
    h('li', {}, [
      h('span', { class: 'tag' + (e.editable ? ' edit' : '') }, e.editable ? 'edit' : 'ro'),
      h('span', { class: 'h-label', title: e.spec.join(' ') }, e.label || e.spec.join(' ')),
      h('span', { class: 'h-time' }, new Date(e.ts).toLocaleString()),
      h('button', { class: 'btn small', onclick: () => switchSpec(e.spec) }, 'Open'),
    ])
  );
  const node = h('div', {}, [
    h('h2', {}, 'History \u2014 this repo'),
    data.entries.length
      ? h('ul', { class: 'history-list' }, items)
      : h('div', { class: 'hint' }, 'No history yet.'),
    h('div', { class: 'row' }, [h('button', { class: 'btn', onclick: closeModal }, 'Close')]),
  ]);
  openModal(node);
}

// ---- wire up -------------------------------------------------------------
document.getElementById('refreshBtn').addEventListener('click', loadSession);
document.getElementById('compareBtn').addEventListener('click', openCompare);
document.getElementById('historyBtn').addEventListener('click', openHistory);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

loadSession();
