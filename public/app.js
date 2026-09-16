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

// ---- app state -----------------------------------------------------------
const App = {
  session: null,
  _editors: [],
  _observer: null,
};

function disposeEditors() {
  App._observer?.disconnect();
  App._observer = null;
  for (const editor of App._editors) editor.dispose();
  App._editors = [];
}

async function loadSession() {
  disposeEditors();
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
  disposeEditors();
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
  const body = h('div', { class: 'filecard-body' }, [h('div', { class: 'empty' }, 'Loading\u2026')]);
  const actions = h('span', { class: 'card-actions' });

  const toggle = h('button', {
    class: 'card-toggle',
    type: 'button',
    title: 'Collapse file',
    'aria-expanded': 'true',
  }, '\u25be');

  const head = h('div', { class: 'filecard-head' }, [
    toggle,
    h('span', { class: 'status-badge st-' + (STATUS_LABEL[f.status] || 'M') }, STATUS_LABEL[f.status] || 'M'),
    h('span', { class: 'path', title: f.path }, f.oldPath ? f.oldPath + ' \u2192 ' + f.path : f.path),
    h('span', { class: 'grow' }),
    h('span', { class: 'counts', html: countsHTML(f) }),
    actions,
  ]);

  const card = h('div', { class: 'filecard', id: fileCardId(f.path) }, [head, body]);

  toggle.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '\u25b8' : '\u25be';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.title = collapsed ? 'Expand file' : 'Collapse file';
  });

  if (f.binary) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'binary' }, 'Binary file \u2014 not shown.'));
    return card;
  }

  observeForMount(f, body, head, actions);
  return card;
}

// ---- Monaco inline editor -----------------------------------------------
const COLLAPSE_PX = 600;

function diffOpts(readOnly) {
  return {
    renderSideBySide: false,
    automaticLayout: false,
    readOnly, domReadOnly: readOnly,
    originalEditable: false,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
    minimap: { enabled: false },
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    lineNumbersMinChars: 4,
    fontSize: 12.5,
    scrollbar: { vertical: 'hidden', alwaysConsumeMouseWheel: false },
  };
}

function observeForMount(f, body, head, actions) {
  body._mount = () => mountDiffEditor(f, body, head, actions);
  if (typeof IntersectionObserver === 'undefined') {
    body._mount();
    return;
  }
  if (!App._observer) {
    App._observer = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (entry.target.isConnected) entry.target._mount();
      }
    }, { root: null, rootMargin: '400px 0px' });
  }
  App._observer.observe(body);
}

let _monacoPromise = null;

// loadMonaco lazily injects the vendored, embedded Monaco (public/vs) the first
// time an editable file approaches the viewport.
function loadMonaco() {
  if (_monacoPromise) return _monacoPromise;
  _monacoPromise = new Promise((resolve, reject) => {
    // Offline web-worker setup: the worker sets its own baseUrl then pulls in
    // the vendored workerMain from the same origin. No CDN, no network.
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const src =
          "self.MonacoEnvironment={baseUrl:'" + location.origin + "/vs'};" +
          "importScripts('" + location.origin + "/vs/base/worker/workerMain.js');";
        return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      },
    };
    const s = document.createElement('script');
    s.src = '/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '/vs' } });
      window.require(
        ['vs/editor/editor.main'],
        () => {
          const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          window.monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
          resolve(window.monaco);
        },
        reject
      );
    };
    s.onerror = () => reject(new Error('failed to load /vs/loader.js'));
    document.head.appendChild(s);
  });
  return _monacoPromise;
}

// langForPath maps a path to a Monaco language id using Monaco's own registry.
function langForPath(monaco, p) {
  const base = p.split('/').pop();
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  for (const l of monaco.languages.getLanguages()) {
    if ((l.filenames || []).some((fn) => fn === base)) return l.id;
    if (ext && (l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
  }
  return 'plaintext';
}

function countsHTML(f) {
  return (
    '<span class="add" style="color:var(--add-text)">+' + f.additions + '</span> ' +
    '<span class="del" style="color:var(--del-text)">\u2212' + f.deletions + '</span>'
  );
}

// updateCounts refreshes the card head, sidebar row, and header totals in place
// after a save, without tearing down the open editor.
function updateCounts(head, f) {
  const s = App.session;
  const hc = head.querySelector('.counts');
  if (hc) hc.innerHTML = countsHTML(f);
  document.querySelectorAll('.filelist li').forEach((li) => {
    if (li.getAttribute('data-path') !== f.path) return;
    const c = li.querySelector('.counts');
    if (c) {
      c.innerHTML =
        '<span class="add">+' + f.additions + '</span> ' +
        '<span class="del">\u2212' + f.deletions + '</span>';
    }
  });
  let addT = 0;
  let delT = 0;
  for (const x of s.files) {
    addT += x.additions;
    delT += x.deletions;
  }
  document.getElementById('totals').innerHTML =
    '<span class="add" style="color:var(--add-text)">+' + addT + '</span> ' +
    '<span class="del" style="color:var(--del-text)">\u2212' + delT + '</span>';
}

async function mountDiffEditor(f, body, head, actions) {
  const editors = App._editors;
  // Read-only diffs (staged, ref-to-ref, ranges) and deletions render Monaco
  // read-only: syntax-highlighted and consistent, but never editable/saved.
  const editable = !!App.session.editable && f.status !== 'D';
  let data;
  let monaco;
  try {
    [data, monaco] = await Promise.all([
      api('/api/file?path=' + encodeURIComponent(f.path)),
      loadMonaco(),
    ]);
  } catch (e) {
    if (editors !== App._editors) return;
    body.replaceChildren(h('div', { class: 'banner' }, 'Editor failed to load: ' + e.message));
    return;
  }
  // A diff switch may have removed this card while its assets were loading.
  if (editors !== App._editors) return;

  const host = h('div', { class: 'monaco-host' });
  const bar = h('div', { class: 'expand-bar', hidden: '' });
  const wrap = h('div', { class: 'monaco-wrap' }, [host, bar]);
  body.replaceChildren(wrap);

  const lang = langForPath(monaco, f.path);
  const original = monaco.editor.createModel(data.base || '', lang);
  const modified = monaco.editor.createModel(data.content || '', lang);
  const diffEditor = monaco.editor.createDiffEditor(host, diffOpts(!editable));
  diffEditor.setModel({ original, modified });

  // Monaco's inline diff attaches a mousedown handler to deleted-line view
  // zones (InlineDiffDeletedCodeMargin) that calls preventDefault() and pops a
  // "Copy deleted lines / Revert this change" context menu. That preventDefault
  // blocks normal text selection on deleted lines, so they behave differently
  // from added lines. Monaco offers no option to disable it and the class is
  // module-private, so intercept the event in the capture phase before Monaco
  // sees it. Monaco layers a transparent .view-lines overlay above the deleted
  // content, so the event target is that overlay rather than the .line-delete
  // node -- probe the full hit-stack at the cursor to detect a deleted zone.
  const DELETED_SEL = '.line-delete, .inline-deleted-margin-view-zone';
  const overDeletedZone = (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest(DELETED_SEL)) return true;
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (el.closest(DELETED_SEL)) return true;
    }
    return false;
  };
  const stopDeletedMenu = (e) => {
    if (overDeletedZone(e)) e.stopImmediatePropagation();
  };
  host.addEventListener('mousedown', stopDeletedMenu, true);

  const modEd = diffEditor.getModifiedEditor();
  let expanded = false;
  let capped = false;
  let disposed = false;
  const toggle = h('button', { class: 'btn small', onclick: () => {
    expanded = !expanded;
    fit();
  } });
  bar.appendChild(toggle);
  const renderBar = () => {
    bar.hidden = !capped;
    wrap.classList.toggle('collapsed', capped && !expanded);
    toggle.textContent = expanded ? 'Collapse \u25b4' : 'Expand \u25be';
  };
  const fit = () => {
    if (disposed) return;
    const full = Math.max(modEd.getContentHeight(), 30);
    capped = full > COLLAPSE_PX;
    const hgt = capped && !expanded ? COLLAPSE_PX : full;
    host.style.height = hgt + 'px';
    diffEditor.layout({ width: host.clientWidth, height: hgt });
    renderBar();
  };
  const sizeSub = modEd.onDidContentSizeChange(fit);
  const diffSub = diffEditor.onDidUpdateDiff(fit);
  const frame = requestAnimationFrame(fit);
  window.addEventListener('resize', fit);

  let changeSub;
  let saveAction;
  if (editable) {
    const saveBtn = h('button', { class: 'btn small primary', disabled: '' }, 'Save');
    actions.appendChild(saveBtn);
    let savedContent = modified.getValue();
    let saving = false;
    const updateSave = () => {
      saveBtn.disabled = saving || modified.getValue() === savedContent;
    };
    changeSub = modEd.onDidChangeModelContent(updateSave);
    const save = async () => {
      if (disposed || saveBtn.disabled) return;
      const content = modEd.getValue();
      saving = true;
      updateSave();
      try {
        const res = await api('/api/file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: f.path, content }),
        });
        if (disposed) return;
        f.additions = res.additions;
        f.deletions = res.deletions;
        updateCounts(head, f);
        savedContent = content;
        toast('Saved ' + f.path);
      } catch (e) {
        toast('Save failed: ' + e.message);
      } finally {
        saving = false;
        if (!disposed) updateSave();
      }
    };
    // addAction scopes its keybinding to this editor and can be disposed.
    saveAction = modEd.addAction({
      id: 'save-working-file',
      label: 'Save working file',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: save,
    });
    saveBtn.addEventListener('click', save);
  }
  editors.push({
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
      host.removeEventListener('mousedown', stopDeletedMenu, true);
      sizeSub.dispose();
      diffSub.dispose();
      changeSub?.dispose();
      saveAction?.dispose();
      diffEditor.dispose();
      original.dispose();
      modified.dispose();
    },
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
