// Product serialiser dispatch — the ONE place a target platform's product CSV is written from the canon. Used by the
// conversion (index.ts) and by the destination probe (destinations.ts), so what step 3 says a field becomes is what
// the export really writes.
import type { CanonProduct, Platform } from './types';
import type { Row } from './csv';
import { serializeShopifyProducts, serializeWooModern, carryPivotExtras } from './products';
import { serializeWixProducts } from './wix';
import { serializeBigCommerceProducts } from './bigcommerce';

// capabilityFor() refuses a target with no serializer before any work starts; this is the backstop so a platform
// can never silently get another platform's CSV.
export function noSerializer(target: Platform): never {
  throw new Error(`no serializer for target platform "${target}"`);
}

export function serializeProductsFor(target: Platform, products: CanonProduct[], categoriesAsTags = false, parentSkus: Map<number, string> = new Map()): { headers: string[]; rows: Row[] } {
  switch (target) {
    case 'shopify': return serializeShopifyProducts(carryPivotExtras('shopify', products), { categoriesAsTags });
    case 'woocommerce': return serializeWooModern(carryPivotExtras('woo', products), { parentSkus });
    case 'wix': return serializeWixProducts(products);
    case 'bigcommerce': return serializeBigCommerceProducts(products);
    default: return noSerializer(target);
  }
}
