import type { FormatKnowledge } from './schema';

export type RowCondition = Record<string, unknown>;
export type UnitRows = { head: number; rows: number[]; children: number[] };

export function rowMatches(row: Record<string, string>, cond?: RowCondition): boolean;
export function unitsOfRows(spec: Record<string, unknown> | undefined, rows: Record<string, string>[]): UnitRows[];
export function declaredColumns(format: FormatKnowledge): { has: (column: string) => boolean };
export function annotateUnits(
  format: FormatKnowledge,
  table: { headers: string[]; rows: Record<string, string>[] },
  units: object[],
  opts?: { childKey?: 'variants' | 'lineItems'; overrideColumns?: Record<string, string | null> },
): { aligned: boolean; unknownColumns: { column: string; units: number }[] };
