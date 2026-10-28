export interface PciFinding { path: string; kind: 'pan' | 'cvv' | 'iin' | 'last4' | 'expiry' | 'holder' | 'token' | 'bank' | 'credential' | 'card-container'; via: 'name' | 'shape' | 'container'; rows?: number }
export function loadPciConfigSync(fp?: string): Record<string, unknown>;
export function luhnValid(s: string | number): boolean;
export function scanForCardData<T>(input: T, opts?: { config?: Record<string, unknown>; strip?: boolean }): { value: T; findings: PciFinding[] };
export function scanTable(table: { headers: string[]; rows: Record<string, string>[]; malformed: number[] }, opts?: { config?: Record<string, unknown> }): { headers: string[]; rows: Record<string, string>[]; malformed: number[]; findings: PciFinding[] };
