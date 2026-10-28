import type { FormatKnowledge, FormatSignature, SampleShape, SignatureMatch, SignatureMatchKind } from './schema';
import type { KnowledgeStore } from './store';

export type MatchResult = Omit<SignatureMatch, 'formatId'>;
export interface LegacyDetection {
  format: string;
  platform: string | null;
  entity: 'products' | 'customers' | 'orders' | null;
  /** KnowledgeStore FormatId behind the detection (null when unknown). */
  knowledgeId: string | null;
  /** Human name of the knowledge entry (null when unknown). */
  displayName: string | null;
  /** Set when a taught format matched a file that is nearly, not exactly, its column set. */
  similar?: { added: number; missing: number };
}
export interface FormatRecognizer {
  recognize(input: SampleShape): Promise<SignatureMatch[]>;
  recognizeHeaders(columns: string[]): Promise<SignatureMatch[]>;
  detect(columns: string[]): Promise<LegacyDetection>;
  structuralHash(columns: string[]): string;
}

export function normHeader(s: unknown): string;
export function structuralHash(columns: string[]): string;
export const KIND_RANK: Record<SignatureMatchKind, number>;
export function rankKind(k: SignatureMatchKind): number;
export function isDetected(kind: SignatureMatchKind): boolean;
export function matchSignature(sig: FormatSignature, input: SampleShape): MatchResult;
export function matchFormat(format: FormatKnowledge, input: SampleShape): MatchResult;
export function recognize(input: SampleShape, formats: FormatKnowledge[]): SignatureMatch[];
export function toLegacyDetection(matches: SignatureMatch[], formats: FormatKnowledge[]): LegacyDetection;
export function createFormatRecognizer(store: KnowledgeStore): FormatRecognizer;
