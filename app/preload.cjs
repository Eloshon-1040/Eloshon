// Secure bridge (CommonJS preload). Small, explicit surface — no Node internals,
// no ipcRenderer, no engine internals leak to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eloshon', {
  platform: process.platform,
  uiReady: () => ipcRenderer.send('ui:ready'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  smokeRun: () => ipcRenderer.invoke('smoke:run'),

  // live scrape events (started/phase/discovered/progress/counters/product/intervention/state/done/error)
  onEvent: (cb) => {
    const h = (_e, ev) => { try { cb(ev.t, ev.p); } catch { /* ignore */ } };
    ipcRenderer.on('scrape:event', h);
    return () => ipcRenderer.removeListener('scrape:event', h);
  },

  scrape: {
    start: (input) => ipcRenderer.invoke('scrape:start', input),
    pause: () => ipcRenderer.send('scrape:pause'),
    resume: () => ipcRenderer.send('scrape:resume'),
    stop: () => ipcRenderer.send('scrape:stop'),
    intervention: (action) => ipcRenderer.send('scrape:intervention', action),
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    resume: (id, extra) => ipcRenderer.invoke('jobs:resume', id, extra),
    products: (id, opts) => ipcRenderer.invoke('job:products', id, opts),
    override: (id, key, status) => ipcRenderer.invoke('job:override', id, key, status),
    report: (id) => ipcRenderer.invoke('job:report', id),
  },
  probe: (url, opts) => ipcRenderer.invoke('probe:run', url, { contentType: opts && typeof opts === 'object' && typeof opts.contentType === 'string' ? opts.contentType : 'auto' }),
  teach: {
    run: (url, labels) => ipcRenderer.invoke('teach:run', url, labels),
    cancel: () => ipcRenderer.send('teach:cancel'),
  },
  providers: () => ipcRenderer.invoke('providers:status'),
  accountStatus: () => ipcRenderer.invoke('account:status'),
  unlockStatus: () => ipcRenderer.invoke('unlock:status'),
  unlockRetry: (input) => ipcRenderer.invoke('unlock:retry', input),
  unlockEstimate: (input) => ipcRenderer.invoke('unlock:estimate', input),
  unlockCascade: (input) => ipcRenderer.invoke('unlock:cascade', input),

  openPath: (p) => ipcRenderer.invoke('open:path', p),
  openExternal: (u) => ipcRenderer.invoke('open:external', u),
  showInFolder: (p) => ipcRenderer.invoke('open:folder', p),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  // recipes.json: export the sites' recipes, import a file (preview first), apply the previewed import.
  recipes: {
    export: () => ipcRenderer.invoke('recipes:export'),
    import: () => ipcRenderer.invoke('recipes:import'),
    apply: (previewId) => ipcRenderer.invoke('recipes:apply', previewId),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    save: (list) => ipcRenderer.invoke('sources:save', list),
  },

  // "Votre navigateur" mode (Chrome/Edge extension) — a normal user feature, NOT
  // admin-gated. Invoke-only; only plain primitives cross the bridge, and the main
  // process re-validates everything (domain, recipe and pacing are derived there).
  yourBrowser: {
    status: () => ipcRenderer.invoke('yb:status'),
    availability: (url) => ipcRenderer.invoke('yb:availability', typeof url === 'string' ? url : ''),
    run: (job) => {
      const j = job && typeof job === 'object' ? job : {};
      const l = j.limits && typeof j.limits === 'object' ? j.limits : {};
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      return ipcRenderer.invoke('yb:run', {
        startUrl: typeof j.startUrl === 'string' ? j.startUrl : '',
        store: typeof j.store === 'string' ? j.store : '',
        productType: typeof j.productType === 'string' ? j.productType : '',
        limits: { maxProducts: num(l.maxProducts), maxListPages: num(l.maxListPages), maxDetailPages: num(l.maxDetailPages) },
      });
    },
    pause: (jobId) => ipcRenderer.invoke('yb:pause', typeof jobId === 'string' ? jobId : ''),
    resume: (jobId) => ipcRenderer.invoke('yb:resume', typeof jobId === 'string' ? jobId : ''),
    stop: (jobId) => ipcRenderer.invoke('yb:stop', typeof jobId === 'string' ? jobId : ''),
  },

  // Owner-only admin + paid-provider management. The main process enforces the
  // lock; the renderer only ever receives masked state (never a secret value).
  admin: {
    status: () => ipcRenderer.invoke('admin:status'),
    create: (pass, confirm) => ipcRenderer.invoke('admin:create', pass, confirm),
    unlock: (pass) => ipcRenderer.invoke('admin:unlock', pass),
    lock: () => ipcRenderer.invoke('admin:lock'),
    reset: (confirmText) => ipcRenderer.invoke('admin:reset', confirmText),
    setAutoLock: (ms) => ipcRenderer.invoke('admin:setAutoLock', ms),
    log: (domain) => ipcRenderer.invoke('admin:log', domain),
    testPlan: (url) => ipcRenderer.invoke('admin:testPlan', typeof url === 'string' ? url : ''),
  },
  // Usage ledger, per-domain paid-route opt-in, cost settings, free balance
  // reads — all admin-gated in the main process ({locked:true} when locked).
  usage: {
    summary: () => ipcRenderer.invoke('usage:summary'),
    query: (filter, page) => ipcRenderer.invoke('usage:query', filter || {}, page || {}),
    exportCsv: (filter) => ipcRenderer.invoke('usage:export', filter || {}),
    job: (jobId) => ipcRenderer.invoke('usage:job', typeof jobId === 'string' ? jobId : ''),
    jobRoutes: (jobId) => ipcRenderer.invoke('usage:jobRoutes', typeof jobId === 'string' ? jobId : ''),
  },
  optin: {
    table: () => ipcRenderer.invoke('optin:table'),
    normalize: (input) => ipcRenderer.invoke('optin:normalize', typeof input === 'string' ? input : ''),
    add: (input) => ipcRenderer.invoke('optin:add', typeof input === 'string' ? input : ''),
    set: (domain, route, on) => ipcRenderer.invoke('optin:set', String(domain || ''), String(route || ''), !!on),
  },
  costs: {
    get: () => ipcRenderer.invoke('costs:get'),
    set: (patch) => ipcRenderer.invoke('costs:set', patch || {}),
  },
  balance: {
    refresh: (id) => ipcRenderer.invoke('balance:refresh', String(id || '')),
  },
  provider: {
    list: () => ipcRenderer.invoke('provider:list'),
    setCredentials: (id, fields) => ipcRenderer.invoke('provider:setCredentials', id, fields),
    deleteCredentials: (id, field) => ipcRenderer.invoke('provider:deleteCredentials', id, field),
    test: (id) => ipcRenderer.invoke('provider:test', id),
    importPreview: () => ipcRenderer.invoke('provider:importPreview'),
    importConfirm: (path) => ipcRenderer.invoke('provider:importConfirm', path),
    setEnabled: (id, on) => ipcRenderer.invoke('provider:setEnabled', id, on),
    setKill: (on) => ipcRenderer.invoke('provider:setKill', on),
    setDomain: (domain, id, on) => ipcRenderer.invoke('provider:setDomain', domain, id, on),
    addDomain: (domain) => ipcRenderer.invoke('provider:addDomain', domain),
    removeDomain: (domain) => ipcRenderer.invoke('provider:removeDomain', domain),
    setCap: (id, patch) => ipcRenderer.invoke('provider:setCap', id, patch),
    usage: () => ipcRenderer.invoke('provider:usage'),
  },
});
