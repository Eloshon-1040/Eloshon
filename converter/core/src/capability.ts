import type { Platform, Entity, DiagParams } from './types';

// The single source of truth for what a (source → target, entity) conversion can
// actually do. One matrix drives three surfaces so they can never disagree:
//   1. the per-direction compatibility table on the page (status → localised),
//   2. the tool's refuse-before-processing guard (an impossible file is stopped
//      with a localised reason, not half-converted),
//   3. the losses section (together with the per-entity loss functions).
// Nothing here is prose: the impossible cases carry a translation CODE that the
// UI renders in the viewer's language.

export type CapStatus = 'clean' | 'lossy' | 'impossible';
export type Capability = { status: CapStatus; code?: string; params?: DiagParams };

// The only platforms a CSV can be written for. Shopware, PrestaShop, BigBuy and
// Eloshon Scraper are read as sources; they have no serializer.
export const FILE_TARGETS: readonly Platform[] = ['shopify', 'woocommerce', 'wix', 'bigcommerce'];
const TARGET_NAMES: Partial<Record<Platform, string>> = {
  shopware: 'Shopware', prestashop: 'PrestaShop', bigbuy: 'BigBuy', eloshon: 'Eloshon Scraper',
};

// Two hard truths about CSV import, straight from the platforms:
//  - BigCommerce has NO order CSV import (orders are API-only), so it can never
//    be an order TARGET by file — only an order source.
//  - Wix imports ONLY products by CSV; it has no customer or order CSV import,
//    so it can never be a customer/order target by file.
export function capabilityFor(source: Platform, target: Platform, entity: Entity): Capability {
  // A platform with no serializer must never fall through to another platform's
  // CSV (the dispatch in index.ts used to default to Shopify with ok:true).
  if (!FILE_TARGETS.includes(target))
    return { status: 'impossible', code: 'impossible_target_unsupported', params: { target: TARGET_NAMES[target] ?? target } };
  if (entity === 'orders' && target === 'bigcommerce')
    return { status: 'impossible', code: 'impossible_bc_orders' };
  if (target === 'wix' && entity !== 'products')
    return { status: 'impossible', code: entity === 'customers' ? 'impossible_wix_customers' : 'impossible_wix_orders' };
  // Everything else converts, at least a little lossily (each platform has fields
  // the others don't). The per-entity DETAIL shown on the page comes from the
  // compat i18n (status × entity); no prose is needed here.
  return { status: 'lossy' };
}

// True when the tool must stop before doing any work.
export function isImpossible(source: Platform, target: Platform, entity: Entity): boolean {
  return capabilityFor(source, target, entity).status === 'impossible';
}
