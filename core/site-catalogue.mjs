/**
 * Site catalogue cache — manages cached classification and product data.
 * Cache is stored as JSON files in a configurable directory.
 *
 * Classification (3 classes):
 *   http      — works without a browser (plain HTTP + extraction)
 *   browser   — needs a local browser (Playwright/Edge), no anti-bot barrier
 *   protected — still blocked after every free technique
 *
 * Backward compat: reads `easy` as `http`, `hard` as `protected`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';

const CLASS_COMPAT = { easy: 'http', hard: 'protected' };
const VALID_CLASSES = new Set(['http', 'browser', 'protected']);
const FREE_QUOTA_CLASSES = new Set(['http', 'browser']);

function normClass(c) { return CLASS_COMPAT[c] || c || 'protected'; }

export function isFreeQuota(classification) {
  return FREE_QUOTA_CLASSES.has(normClass(classification));
}

export function createCatalogueStore(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  const config = cfg || loadConfig();

  function filePath(domain) {
    return path.join(dir, `${domain.replace(/\./g, '_')}.json`);
  }

  function read(domain) {
    const fp = filePath(domain);
    if (!fs.existsSync(fp)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (entry.classification && CLASS_COMPAT[entry.classification]) {
        entry.classification = normClass(entry.classification);
      }
      return entry;
    } catch { return null; }
  }

  function write(domain, entry) {
    entry.cachedAt = new Date().toISOString();
    if (entry.classification) entry.classification = normClass(entry.classification);
    fs.writeFileSync(filePath(domain), JSON.stringify(entry, null, 2));
    return entry;
  }

  function ttlFor(entry) {
    if (!entry) return 0;
    if (entry.method === 'recipe') return config.catalogueTtlRecipeMs;
    const cls = normClass(entry.classification);
    if (cls === 'browser') return config.catalogueTtlBrowserMs;
    return config.catalogueTtlHttpMs;
  }

  function isStale(entry) {
    if (!entry || !entry.cachedAt) return true;
    const age = Date.now() - Date.parse(entry.cachedAt);
    return age > ttlFor(entry);
  }

  function listAll() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== 'catalogue-report.json')
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; } })
      .filter(Boolean)
      .map(e => ({ ...e, classification: normClass(e.classification) }));
  }

  function listByClass(cls) { return listAll().filter(e => e.classification === cls); }

  function listEasy() { return listByClass('http'); }

  function allProducts() {
    return listEasy().flatMap(e => e.products || []);
  }

  function report() {
    const all = listAll();
    const http = all.filter(e => e.classification === 'http');
    const browser = all.filter(e => e.classification === 'browser');
    const protectedSites = all.filter(e => e.classification === 'protected');
    const stale = all.filter(isStale);
    return {
      total: all.length,
      http: http.length, browser: browser.length, protected: protectedSites.length,
      easy: http.length, hard: protectedSites.length,
      staleCount: stale.length, staleDomains: stale.map(e => e.domain),
      totalProducts: http.reduce((n, e) => n + (e.productCount || 0), 0),
    };
  }

  return { read, write, isStale, listEasy, listByClass, listAll, allProducts, report, filePath };
}
