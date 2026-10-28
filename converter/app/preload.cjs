// Preload — the ONLY bridge between the sandboxed renderer and the main process.
// Exposes a small, explicit API on window.eloshon; no Node access leaks to the UI.
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);

contextBridge.exposeInMainWorld('eloshon', {
  info: () => invoke('app:info'),
  account: {
    status: () => invoke('account:status'),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
  config: {
    get: () => invoke('config:get'),
    set: (patch) => invoke('config:set', patch),
  },
  license: {
    get: () => invoke('license:get'),
    activate: (key) => invoke('license:activate', key),
    deactivate: () => invoke('license:deactivate'),
  },
  history: {
    get: () => invoke('history:get'),
    add: (entry) => invoke('history:add', entry),
    remove: (id) => invoke('history:remove', id),
    clear: () => invoke('history:clear'),
  },
  file: {
    open: (opts) => invoke('file:open', opts || {}),
    // Drag-and-drop: ship the text across the bridge ONCE; every later engine
    // call references the returned fileId instead of the whole file.
    register: (payload) => invoke('file:register', payload),
    // Replaced/abandoned file: free its text in the engine host (main + worker).
    forget: (fileId) => invoke('file:forget', fileId),
    chooseDir: () => invoke('dir:choose'),
    openFolder: (p) => invoke('file:openFolder', p),
    showItem: (p) => invoke('file:showItem', p),
  },
  conv: {
    // `file` is { fileId } (registered) or { csvText } (fallback).
    analyze: (file, direction, overrides) => invoke('conv:analyze', { ...file, direction, overrides }),
    issues: (file, direction, edits) => invoke('conv:issues', { ...file, direction, ...(edits || {}) }),
    run: (input) => invoke('conv:run', input),
    save: (payload) => invoke('conv:save', payload),
    onProgress: (cb) => { ipcRenderer.on('conv:progress', (_e, p) => cb(p)); },
  },
  // The data editor (rename / replace / cut text, fix prices…) — formulas, live preview, recipes.
  edits: {
    catalog: () => invoke('edits:catalog'),
    preview: (file, edits, column) => invoke('edits:preview', { ...file, edits, column }),
    expand: (presetId, column) => invoke('edits:expand', { presetId, column }),
    suggest: (file) => invoke('edits:suggest', { ...file }),
  },
  kb: {
    decide: (d) => invoke('kb:decide', d),
    decisions: (formatId) => invoke('kb:decisions', formatId),
    forget: (formatId, column) => invoke('kb:forget', { formatId, column }),
    learn: (payload) => invoke('kb:learn', payload),
    formats: () => invoke('kb:formats'),
    forgetFormat: (id) => invoke('kb:forgetFormat', id),
    editColumn: (formatId, column, target) => invoke('kb:editColumn', { formatId, column, target }),
  },
  tpl: {
    list: () => invoke('tpl:list'),
    create: (data) => invoke('tpl:create', data),
    save: (id, patch) => invoke('tpl:save', { id, patch }),
    rename: (id, name) => invoke('tpl:rename', { id, name }),
    duplicate: (id, name) => invoke('tpl:duplicate', { id, name }),
    remove: (id) => invoke('tpl:remove', id),
    apply: (id, headers) => invoke('tpl:apply', { id, headers }),
    export: (id) => invoke('tpl:export', id),
    import: () => invoke('tpl:import'),
  },
});
