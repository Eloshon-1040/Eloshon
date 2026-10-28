/**
 * Freezes the golden regression outputs from the CURRENT engine (ÉTAPE 0).
 * Run ONCE against the unmodified engine, and later ONLY when a change is
 * INTENDED — then eyeball the git diff of core/__tests__/golden before committing.
 *
 *   node scripts/gen-golden.mjs
 */
import fs from 'node:fs';
import { GOLD, KEYS, computeAll } from '../core/__tests__/_regression-cases.mjs';

fs.mkdirSync(GOLD, { recursive: true });
const all = await computeAll();
for (const key of KEYS) {
  const file = `${GOLD}/${key}.json`;
  fs.writeFileSync(file, JSON.stringify(all[key], null, 2) + '\n');
  const n = typeof all[key] === 'object' ? Object.keys(all[key]).length : 0;
  console.log('  golden', key, `(${n} entries)`);
}
console.log('golden outputs written to', GOLD, `(${KEYS.length} files)`);
