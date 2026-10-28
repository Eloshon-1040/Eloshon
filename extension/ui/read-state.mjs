/**
 * What the panel's rows really are, as an export manifest (shared/export/manifest.mjs): a preview of the
 * list, or the accepted result with every product page it read, blocked or never opened. The panel shows
 * its one-line summary next to the table, warns before exporting anything that is not complete, and
 * writes the manifest beside the CSV. Free of chrome.* and of the DOM: tested in Node.
 */
import { buildManifest, manifestSummaryFr } from '../vendor/shared/export/manifest.mjs';
import { subpageUrls } from '../background/subpages.mjs';

const ALL = Number.MAX_SAFE_INTEGER;

/**
 * @param {{ rows:object[], columns:{key:string,label:string}[], read?:(row:object,key:string)=>any, meta?:object,
 *   settings?:object, accepted?:object|null, version?:string, now?:string }} o
 *   `accepted`: the « Accepter » reply ({ enrich, reportStatus, rulesFailing, jobId, rowsTruncated, rowsMissing }).
 */
export function panelManifest(o = {}) {
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const meta = o.meta || {};
  const settings = o.settings || {};
  const acc = o.accepted || null;
  let productPages;
  if (acc) {
    const e = acc.enrich || {};
    productPages = { toRead: e.toRead || 0, read: e.read || 0, blocked: e.blocked || [], notOpened: e.notOpened || [], limit: e.limit || null };
  } else {
    // Before « Accepter »: the pages « Accepter » will read, and what the preview already read of them.
    const wantSub = !!settings.subpages || (Array.isArray(meta.taught) && meta.taught.length > 0);
    const tp = meta.taughtPreview || {};
    productPages = { toRead: wantSub ? subpageUrls(rows, meta.url || '', ALL).length : 0, read: tp.pages || 0, blocked: Array.isArray(tp.blocked) ? tp.blocked : [], byReason: tp.challenged ? { human_check: tp.challenged } : {} };
  }
  let site = '';
  try { site = meta.url ? new URL(meta.url).hostname.replace(/^www\./, '') : ''; } catch { site = ''; }
  const missing = acc && Number(acc.rowsMissing) > 0 ? Number(acc.rowsMissing) : 0;
  return buildManifest({
    source: 'extension', sourceVersion: o.version || null, createdAt: o.now || new Date().toISOString(),
    site, listUrl: meta.url || null, listMethod: meta.method || null, rows, columns: o.columns || [], read: o.read,
    accepted: !!acc, jobId: acc && acc.jobId, jobStatus: acc && acc.reportStatus,
    rulesFailing: acc && Array.isArray(acc.rulesFailing) ? acc.rulesFailing : [],
    truncated: missing ? { rows: missing, reason: 'reply_incomplete' } : null,
    productPages,
  });
}

/** Before « Accepter »: how many product pages it will read, announced with the limit when one is set. */
export function acceptPlanText(manifest, settings = {}) {
  const toRead = (manifest && manifest.productPages && manifest.productPages.toRead) || 0;
  if (!toRead) return '';
  const max = Math.floor(Number(settings.maxProductPages) || 0);
  if (max > 0 && max < toRead) return `« Accepter » lira ${max} fiches sur ${toRead} (réglage « Fiches produit à lire », onglet Pages) ; les ${toRead - max} autres seront signalées comme non lues.`;
  return `« Accepter » lira ${toRead > 1 ? `les ${toRead} fiches produit` : 'la fiche produit'}.`;
}

/** The columns a person should not trust as full: filled on fewer than half of the rows. */
export function thinColumns(manifest) {
  return Object.values((manifest && manifest.fill) || {}).filter((c) => c.total && c.filled / c.total < 0.5);
}

/** The words of the warning shown before exporting something that is not complete. */
export function exportWarning(manifest) {
  if (!manifest || manifest.status === 'complete') return null;
  const thin = thinColumns(manifest).map((c) => `${c.label} ${c.filled}/${c.total}`);
  const thinText = thin.length ? ` Colonnes presque vides : ${thin.join(', ')}.` : '';
  if (manifest.status === 'preview') {
    return {
      title: 'Ceci est un aperçu, pas le résultat complet',
      text: `${manifestSummaryFr(manifest)}.${thinText} « Accepter » lit chaque fiche produit, puis l’export contient le résultat complet.`,
      canAccept: true,
    };
  }
  const why = [];
  const p = manifest.productPages || {};
  if (p.blocked) why.push(`${p.blocked} fiche(s) bloquée(s) ou en échec`);
  if (p.notOpened) why.push(`${p.notOpened} fiche(s) non ouverte(s)${p.limit ? ` (limite de ${p.limit.max} fiches)` : ''}`);
  if (manifest.rulesFailing && manifest.rulesFailing.length) why.push(`règle(s) du site en échec : ${manifest.rulesFailing.map((r) => r.field).join(', ')}`);
  if (manifest.truncated) why.push(`${manifest.truncated.rows} ligne(s) non reçue(s) de l’application`);
  const again = p.blocked || p.notOpened ? ' « Lire les fiches manquantes » ouvre seulement celles-là, sans relire la liste.' : '';
  return {
    title: 'Résultat partiel',
    text: `${manifestSummaryFr(manifest)}.${why.length ? ` ${why.join(' ; ')}.` : ''}${thinText} Le fichier exporté et son manifeste l’indiquent.${again}`,
    canAccept: false,
  };
}

/**
 * Why the app did not keep what the panel asked it to save, in words the user can act on. An app OLDER than the
 * extension answers « demande inconnue »: it is not « closed », it must be updated (28/10: « Enregistrer » looked dead).
 */
export function appWhy(reason) {
  const r = String(reason || '');
  if (/demande inconnue|mettre à jour/i.test(r)) return 'l’application installée est plus ancienne que l’extension : mettez-la à jour pour y enregistrer';
  if (/hors ligne|fermée|n’a pas répondu|aucune réponse|indisponible/i.test(r) || !r) return 'l’application est fermée : lancez-la, puis cliquez sur « Enregistrer »';
  return r;
}
