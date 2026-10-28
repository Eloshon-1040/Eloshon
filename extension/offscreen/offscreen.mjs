/**
 * Offscreen worker — parses HTML with a real DOMParser on behalf of the service
 * worker (which has no DOM). Used for the embedded-state / DOM extraction of an
 * HTML payload the SW obtained itself (e.g. an internal API that returns HTML),
 * so heavy parsing never blocks the SW event loop.
 *
 * Message contract: { kind:'parse', id, html, spec } -> { kind:'parsed', id, products }
 * Purely local; no network, no eval.
 */
import { mapItem } from '../vendor/shared/extract/field-map.mjs';

function extractDom(doc, spec) {
  const items = spec.item_selector ? [...doc.querySelectorAll(spec.item_selector)] : [];
  const selectors = spec.selectors || {};
  const out = [];
  for (const root of items) {
    const raw = {};
    for (const [field, sel] of Object.entries(selectors)) {
      const [css, attr] = String(sel).split('@');
      const node = css ? root.querySelector(css) : root;
      if (!node) continue;
      const v = attr ? node.getAttribute(attr) : node.textContent;
      if (v != null && String(v).trim() !== '') raw[field] = String(v).trim();
    }
    const mapped = mapItem(raw, spec.field_map || Object.fromEntries(Object.keys(selectors).map((k) => [k, k])), { strategy: 'dom' });
    if (Object.keys(mapped).length > 1) out.push(mapped);
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.kind !== 'parse' || msg.target !== 'offscreen') return false;
  try {
    const doc = new DOMParser().parseFromString(String(msg.html || ''), 'text/html');
    reply({ kind: 'parsed', id: msg.id, products: extractDom(doc, msg.spec || {}) });
  } catch (e) {
    reply({ kind: 'parsed', id: msg.id, products: [], error: String(e && e.message || e) });
  }
  return true;
});
