export function axisNameFor(names: string[], opts?: { generic?: string }): string;
export function isGenericAxis(name: string | null | undefined): boolean;
export function parseVariantText(text: string, opts?: { itemSep?: string; kvSep?: string }): Array<{ type: string; name: string; price?: string; availability?: string }>;
