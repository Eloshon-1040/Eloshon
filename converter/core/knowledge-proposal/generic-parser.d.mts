import type { FormatKnowledge } from './schema';
import type { CanonDerivation } from './semantic.mjs';
export interface ParseReport {
  units: number;
  variants: number;
  /** Phase 7: order lines produced (orders only). */
  items?: number;
  unknownKeys: string[];
  warnings: { code: string; unit?: string; expected?: number; count?: number; kinds?: string[] }[];
  pciFindings?: import("./pci-scanner.mjs").PciFinding[];
}
export interface ParseResult<TProduct = unknown> { products: TProduct[]; report: ParseReport }
/** What the parser reads from the canon catalogue document (canon/fields.v1.json): its derivation rules only. */
export interface CanonDerivationsDoc { derivations?: CanonDerivation[] }
export function parseWithKnowledge(format: FormatKnowledge, payload: unknown, opts?: { companions?: Record<string, unknown>; platform?: string; canon?: CanonDerivationsDoc; pci?: boolean }): ParseResult;
export function applyCanonDerivations<T>(products: T[], catalog: CanonDerivationsDoc | undefined, entity?: 'products' | 'orders' | 'customers'): T[];
export function validateFormatTransforms(format: FormatKnowledge): string[];
