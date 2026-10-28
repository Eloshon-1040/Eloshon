/**
 * Site knowledge at scrape time (app side): read what the learned rules say on a product
 * page's HTML, merge it into a product row with the right priority, and fold the
 * outcomes back so the profile's rules keep an honest track record.
 *
 * The merge and the outcome folding are portable (shared/knowledge/apply.mjs), so the
 * extension's panel preview merges exactly like a run does.
 */
import { parseHTML } from 'linkedom';
import { applyKnowledge, rowHas } from '../shared/knowledge/apply.mjs';
import { knownFields } from '../shared/knowledge/rules.mjs';
import { pageJsonPayloads } from '../shared/extract/product-group.mjs';
import { productIdsOf } from '../shared/knowledge/state-values.mjs';

export { rowKeysOf, mergeKnowledgeIntoRow, foldOutcomes } from '../shared/knowledge/apply.mjs';

/**
 * Fields the USER taught on product pages (manual rules): a collection opens its product pages for them.
 * Rules found by the detection / the AI apply on every product page a run reads, but never make a run
 * open pages it would not have opened (a replay stays fast and cheap).
 */
export const wantedFields = (knowledge) => (knowledge ? [...new Set(knowledge.rules.filter((r) => r.scope === 'product' && r.origin === 'manual' && (r.status === 'active' || r.status === 'failing')).map((r) => r.field))] : []);

/** Which wanted fields a row still lacks (a page visit is only worth it for those). */
export function missingFields(row, knowledge) {
  return wantedFields(knowledge).filter((f) => !rowHas(row, f));
}

/** Run the learned product rules on a page's HTML. Never throws. */
export function applyKnowledgeToHtml(html, knowledge, { name = '', url = '' } = {}) {
  if (!html || !knowledge) return null;
  try {
    const { document } = parseHTML(String(html));
    // The page's embedded state: where a rule reads its value when the shop builds the block in the browser.
    let payloads = { json: [], jsonLd: [] }; try { payloads = pageJsonPayloads(String(html)); } catch { /* none */ }
    return applyKnowledge(document, knowledge, { scope: 'product', name, url, html: String(html), payloads: payloads.json, productIds: productIdsOf({ url, jsonLd: payloads.jsonLd }) });
  } catch { return null; }
}
