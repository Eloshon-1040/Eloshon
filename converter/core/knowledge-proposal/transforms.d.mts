export type TransformFn = (value: unknown, ctx: { args?: Record<string, unknown>; source: unknown; parent: unknown; product: unknown; companions: Record<string, unknown>; field: unknown; platform: string }) => unknown;
export const TRANSFORMS: Record<string, TransformFn>;
export function hasTransform(id: string): boolean;
export function applyTransform(id: string, value: unknown, ctx: Parameters<TransformFn>[1]): unknown;
export function toNumber(v: unknown, opts?: { decimal?: string }): number | null;
export function toBool(v: unknown, dflt?: boolean | null): boolean | null;
export function toText(v: unknown): string;
/** true when a date-time string carries its zone designator (Z, ±hh:mm, RFC 2822 zone) — B1 */
export function hasZone(v: unknown): boolean;
export function getPath(obj: unknown, path: string): unknown;
