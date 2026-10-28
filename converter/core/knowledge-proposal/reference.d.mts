import type { FormatKnowledge } from './schema';
export const REFERENCE_DIR: string;
export function loadReferenceFormatsSync(dir?: string): FormatKnowledge[];
export function resetReferenceCache(): void;
export function loadCanonCatalogSync(fp?: string): import('./semantic.mjs').CanonCatalog;
export function loadRecognitionConfigSync(fp?: string): import('./semantic.mjs').RecognitionConfig;
export function loadTransformAliasesSync(fp?: string): import('./learn.mjs').TransformAliases;
export function loadAllFormats(store: import('./store').KnowledgeStore): Promise<FormatKnowledge[]>;
