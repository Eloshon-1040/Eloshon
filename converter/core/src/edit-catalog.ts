// The ready-made "formulas" the editor offers, as DATA: what each operation is called in
// French and English, which Google Sheets formula it stands for, what it asks, and one
// worked example. The example is not decoration: test/edits.test.mjs runs every one of
// them through the engine, so the help text can never drift from what the code does.
// Dutch and Spanish live in edit-catalog-nl.ts / edit-catalog-es.ts, keyed by op, arg key, choice value and
// preset id, and are merged below so every object carries fr, en, nl and es (test/i18n-parity.test.mjs).
import type { EditArg } from './edits';
import { EDIT_CATALOG_NL } from './edit-catalog-nl';
import { EDIT_CATALOG_ES } from './edit-catalog-es';

export type EditLang = 'fr' | 'en' | 'nl' | 'es';
export type EditArgSpec = {
  key: string;
  type: 'text' | 'number' | 'bool' | 'columns' | 'choice' | 'column' | 'longtext';
  fr: string; en: string; nl?: string; es?: string;
  placeholder?: string;
  default?: EditArg;
  /** `help`: the real rule of that choice, shown under the list once it is picked. */
  choices?: { value: string; fr: string; en: string; nl?: string; es?: string; help?: Partial<Record<EditLang, string>> }[];
  optional?: boolean;
};
export type EditGroup = 'text' | 'cut' | 'number' | 'url' | 'column';
export type EditCatalogEntry = {
  op: string;
  group: EditGroup;
  fr: { label: string; help: string };
  en: { label: string; help: string };
  nl?: { label: string; help: string };
  es?: { label: string; help: string };
  /** The Google Sheets formula it corresponds to (A2 = the cell). */
  sheets: string;
  args: EditArgSpec[];
  /** Column operations have no per-cell example. */
  example?: { value: string; args: Record<string, EditArg>; out: string };
};

const T = (key: string, fr: string, en: string, placeholder?: string, extra: Partial<EditArgSpec> = {}): EditArgSpec => ({ key, type: 'text', fr, en, placeholder, ...extra });
const N = (key: string, fr: string, en: string, def?: EditArg, extra: Partial<EditArgSpec> = {}): EditArgSpec => ({ key, type: 'number', fr, en, default: def, ...extra });
const B = (key: string, fr: string, en: string, extra: Partial<EditArgSpec> = {}): EditArgSpec => ({ key, type: 'bool', fr, en, optional: true, ...extra });

export const EDIT_GROUPS: { id: EditGroup; fr: string; en: string; nl?: string; es?: string }[] = [
  { id: 'text', fr: 'Texte', en: 'Text' },
  { id: 'cut', fr: 'Couper, ajouter, insérer', en: 'Cut, add, insert' },
  { id: 'number', fr: 'Nombres et prix', en: 'Numbers and prices' },
  { id: 'url', fr: 'URL, slug, HTML', en: 'URL, slug, HTML' },
  { id: 'column', fr: 'Colonnes', en: 'Columns' },
];

export const EDIT_CATALOG: EditCatalogEntry[] = [
  // ── text ──
  { op: 'replace', group: 'text', sheets: 'SUBSTITUTE(A2; "ancien"; "nouveau")',
    fr: { label: 'Remplacer un texte', help: 'Remplace chaque occurrence d’un texte par un autre (vide = le supprimer).' },
    en: { label: 'Replace text', help: 'Replaces every occurrence of a text with another (empty = delete it).' },
    args: [T('find', 'Texte à chercher', 'Text to find', ' | '), T('with', 'Remplacer par', 'Replace with', '', { optional: true }), B('matchCase', 'Respecter les majuscules', 'Match case'), B('whole', 'Seulement si la case est exactement ce texte', 'Only if the whole cell equals it')],
    example: { value: 'Vodka | Blanc | 37,5%', args: { find: ' | ', with: ' ' }, out: 'Vodka Blanc 37,5%' } },
  { op: 'remove', group: 'text', sheets: 'SUBSTITUTE(A2; "texte"; "")',
    fr: { label: 'Retirer un texte', help: 'Supprime ce texte partout dans la case.' },
    en: { label: 'Remove text', help: 'Deletes this text everywhere in the cell.' },
    args: [T('text', 'Texte à retirer', 'Text to remove', ',')],
    example: { value: '1,299', args: { text: ',' }, out: '1299' } },
  { op: 'remove_chars', group: 'text', sheets: 'REGEXREPLACE(A2; "[,;]"; "")',
    fr: { label: 'Retirer certains caractères', help: 'Supprime chacun des caractères listés (ex. « ,;| »).' },
    en: { label: 'Remove characters', help: 'Deletes each listed character (e.g. “,;|”).' },
    args: [T('chars', 'Caractères', 'Characters', ',;|')],
    example: { value: 'a,b;c|d', args: { chars: ',;|' }, out: 'abcd' } },
  { op: 'join_segments', group: 'text', sheets: 'TEXTJOIN(" "; TRUE; SPLIT(A2; "|"))',
    fr: { label: 'Changer le séparateur', help: 'Remplace un séparateur (ex. « | ») par un autre, en retirant les espaces autour.' },
    en: { label: 'Change the separator', help: 'Replaces a separator (e.g. “|”) with another, trimming the spaces around it.' },
    args: [T('sep', 'Séparateur actuel', 'Current separator', '|'), T('with', 'Nouveau séparateur', 'New separator', ' ', { optional: true })],
    example: { value: 'Eristoff | Vodka | Blanc', args: { sep: '|', with: ' ' }, out: 'Eristoff Vodka Blanc' } },
  { op: 'dedupe_segments', group: 'text', sheets: 'TEXTJOIN(" | "; TRUE; UNIQUE(SPLIT(A2; "|")))',
    fr: { label: 'Retirer les parties répétées', help: 'Coupe la case sur un séparateur et garde chaque partie une seule fois.' },
    en: { label: 'Remove repeated parts', help: 'Splits the cell on a separator and keeps each part once.' },
    args: [T('sep', 'Séparateur', 'Separator', '|', { default: '|' })],
    example: { value: 'Vodka | Blanc | Vodka', args: { sep: '|' }, out: 'Vodka | Blanc' } },
  { op: 'dedupe_words', group: 'text', sheets: 'TEXTJOIN(" "; TRUE; UNIQUE(SPLIT(A2; " ")))',
    fr: { label: 'Retirer les mots répétés', help: 'Garde chaque mot une seule fois (sans tenir compte des majuscules).' },
    en: { label: 'Remove repeated words', help: 'Keeps each word once (case-insensitive).' },
    args: [],
    example: { value: 'Vodka Blanc vodka 70 cl', args: {}, out: 'Vodka Blanc 70 cl' } },
  { op: 'trim', group: 'text', sheets: 'TRIM(A2)',
    fr: { label: 'Nettoyer les espaces', help: 'Retire les espaces au début et à la fin et réduit les doubles espaces.' },
    en: { label: 'Clean spaces', help: 'Removes leading / trailing spaces and collapses double spaces.' },
    args: [],
    example: { value: '  Vodka   Blanc ', args: {}, out: 'Vodka Blanc' } },
  { op: 'upper', group: 'text', sheets: 'UPPER(A2)', fr: { label: 'EN MAJUSCULES', help: 'Met tout le texte en majuscules.' }, en: { label: 'UPPERCASE', help: 'Makes the whole text uppercase.' }, args: [],
    example: { value: 'Vodka blanc', args: {}, out: 'VODKA BLANC' } },
  { op: 'lower', group: 'text', sheets: 'LOWER(A2)', fr: { label: 'en minuscules', help: 'Met tout le texte en minuscules.' }, en: { label: 'lowercase', help: 'Makes the whole text lowercase.' }, args: [],
    example: { value: 'VODKA Blanc', args: {}, out: 'vodka blanc' } },
  { op: 'proper', group: 'text', sheets: 'PROPER(A2)', fr: { label: 'Majuscule À Chaque Mot', help: 'Première lettre de chaque mot en majuscule, le reste en minuscules.' }, en: { label: 'Title Case', help: 'First letter of each word uppercase, the rest lowercase.' }, args: [],
    example: { value: 'vodka BLANC 70 cl', args: {}, out: 'Vodka Blanc 70 Cl' } },
  { op: 'regex_replace', group: 'text', sheets: 'REGEXREPLACE(A2; "motif"; "nouveau")',
    fr: { label: 'Remplacer (motif avancé)', help: 'Remplace ce qui correspond à une expression régulière (comme REGEXREPLACE). $1 reprend un groupe.' },
    en: { label: 'Replace (advanced pattern)', help: 'Replaces what matches a regular expression (like REGEXREPLACE). $1 reuses a group.' },
    args: [T('pattern', 'Motif', 'Pattern', '\\s*\\(.*?\\)'), T('with', 'Remplacer par', 'Replace with', '', { optional: true })],
    example: { value: 'Vodka (70 cl) Blanc', args: { pattern: '\\s*\\(.*?\\)', with: '' }, out: 'Vodka Blanc' } },
  { op: 'regex_extract', group: 'text', sheets: 'REGEXEXTRACT(A2; "motif")',
    fr: { label: 'Extraire avec un motif', help: 'Ne garde que la partie qui correspond au motif (vide si rien ne correspond).' },
    en: { label: 'Extract with a pattern', help: 'Keeps only the part matching the pattern (empty if nothing matches).' },
    args: [T('pattern', 'Motif', 'Pattern', '\\d+\\s?cl'), N('group', 'Groupe (0 = tout)', 'Group (0 = all)', 0, { optional: true })],
    example: { value: 'Vodka Blanc 70 cl 37,5%', args: { pattern: '\\d+\\s?cl' }, out: '70 cl' } },
  { op: 'set', group: 'text', sheets: '="valeur"', fr: { label: 'Remplir avec une valeur', help: 'Met la même valeur dans toutes les cases (ou celles qui répondent à la condition).' }, en: { label: 'Fill with a value', help: 'Puts the same value in every cell (or those matching the condition).' },
    args: [T('text', 'Valeur', 'Value', 'Alcool')], example: { value: 'x', args: { text: 'Alcool' }, out: 'Alcool' } },
  { op: 'fill_empty', group: 'text', sheets: 'IF(A2=""; "valeur"; A2)', fr: { label: 'Remplir les cases vides', help: 'Met une valeur seulement dans les cases vides.' }, en: { label: 'Fill empty cells', help: 'Puts a value only in empty cells.' },
    args: [T('text', 'Valeur', 'Value', '0')], example: { value: '', args: { text: '0' }, out: '0' } },

  // ── cut / add / insert ──
  { op: 'prefix_add', group: 'cut', sheets: '"texte" & A2', fr: { label: 'Ajouter au début', help: 'Ajoute un texte devant le contenu.' }, en: { label: 'Add at the start', help: 'Adds a text in front of the content.' },
    args: [T('text', 'Texte à ajouter', 'Text to add', 'https://monsite.be/')], example: { value: 'vodka-blanc', args: { text: 'https://monsite.be/' }, out: 'https://monsite.be/vodka-blanc' } },
  { op: 'suffix_add', group: 'cut', sheets: 'A2 & "texte"', fr: { label: 'Ajouter à la fin', help: 'Ajoute un texte après le contenu.' }, en: { label: 'Add at the end', help: 'Adds a text after the content.' },
    args: [T('text', 'Texte à ajouter', 'Text to add', ' 70 cl')], example: { value: 'Vodka', args: { text: ' 70 cl' }, out: 'Vodka 70 cl' } },
  { op: 'prefix_remove', group: 'cut', sheets: 'IF(LEFT(A2; LEN("t"))="t"; MID(A2; LEN("t")+1; 999); A2)', fr: { label: 'Retirer le début', help: 'Retire ce texte s’il commence la case (sinon ne change rien).' }, en: { label: 'Remove the start', help: 'Removes this text if the cell starts with it (otherwise nothing changes).' },
    args: [T('text', 'Début à retirer', 'Start to remove', 'https://www.delhaize.be')], example: { value: 'https://www.delhaize.be/fr/p/123', args: { text: 'https://www.delhaize.be' }, out: '/fr/p/123' } },
  { op: 'suffix_remove', group: 'cut', sheets: 'IF(RIGHT(A2; LEN("t"))="t"; LEFT(A2; LEN(A2)-LEN("t")); A2)', fr: { label: 'Retirer la fin', help: 'Retire ce texte s’il termine la case (sinon ne change rien).' }, en: { label: 'Remove the end', help: 'Removes this text if the cell ends with it (otherwise nothing changes).' },
    args: [T('text', 'Fin à retirer', 'End to remove', ' ALC.')], example: { value: 'Vodka 37,5% ALC.', args: { text: ' ALC.' }, out: 'Vodka 37,5%' } },
  { op: 'keep_before', group: 'cut', sheets: 'LEFT(A2; FIND("t"; A2)-1)', fr: { label: 'Garder ce qui précède un texte', help: 'Coupe la case au premier (ou dernier) texte indiqué et garde ce qui est avant.' }, en: { label: 'Keep what comes before a text', help: 'Cuts the cell at the first (or last) given text and keeps what is before.' },
    args: [T('text', 'Texte repère', 'Marker text', '|'), B('last', 'Au dernier plutôt qu’au premier', 'At the last rather than the first')], example: { value: 'Vodka | Blanc | 70 cl', args: { text: '|' }, out: 'Vodka ' } },
  { op: 'keep_after', group: 'cut', sheets: 'MID(A2; FIND("t"; A2)+LEN("t"); 999)', fr: { label: 'Garder ce qui suit un texte', help: 'Coupe la case au premier (ou dernier) texte indiqué et garde ce qui est après.' }, en: { label: 'Keep what comes after a text', help: 'Cuts the cell at the first (or last) given text and keeps what is after.' },
    args: [T('text', 'Texte repère', 'Marker text', '/p/'), B('last', 'Au dernier plutôt qu’au premier', 'At the last rather than the first')], example: { value: 'https://x.be/fr/p/S123', args: { text: '/p/' }, out: 'S123' } },
  { op: 'split_take', group: 'cut', sheets: 'INDEX(SPLIT(A2; "|"); 1; n)', fr: { label: 'Garder la Nᵉ partie', help: 'Coupe sur un séparateur et garde la partie numéro N (1 = première, -1 = dernière).' }, en: { label: 'Keep the Nth part', help: 'Splits on a separator and keeps part number N (1 = first, -1 = last).' },
    args: [T('sep', 'Séparateur', 'Separator', '|'), N('index', 'Numéro de la partie', 'Part number', 1)], example: { value: 'Eristoff | Vodka | Blanc', args: { sep: '|', index: 2 }, out: 'Vodka' } },
  { op: 'keep_left', group: 'cut', sheets: 'LEFT(A2; n)', fr: { label: 'Garder les N premiers caractères', help: 'Coupe le texte après N caractères.' }, en: { label: 'Keep the first N characters', help: 'Cuts the text after N characters.' },
    args: [N('n', 'Nombre de caractères', 'Number of characters', 70)], example: { value: 'Vodka Blanc', args: { n: 5 }, out: 'Vodka' } },
  { op: 'keep_right', group: 'cut', sheets: 'RIGHT(A2; n)', fr: { label: 'Garder les N derniers caractères', help: 'Garde seulement la fin du texte.' }, en: { label: 'Keep the last N characters', help: 'Keeps only the end of the text.' },
    args: [N('n', 'Nombre de caractères', 'Number of characters', 5)], example: { value: 'Vodka Blanc', args: { n: 5 }, out: 'Blanc' } },
  { op: 'drop_left', group: 'cut', sheets: 'MID(A2; n+1; LEN(A2))', fr: { label: 'Retirer les N premiers caractères', help: 'Supprime le début du texte, quel qu’il soit.' }, en: { label: 'Remove the first N characters', help: 'Deletes the start of the text, whatever it is.' },
    args: [N('n', 'Nombre de caractères', 'Number of characters', 1)], example: { value: 'XVodka', args: { n: 1 }, out: 'Vodka' } },
  { op: 'drop_right', group: 'cut', sheets: 'LEFT(A2; LEN(A2)-n)', fr: { label: 'Retirer les N derniers caractères', help: 'Supprime la fin du texte, quelle qu’elle soit.' }, en: { label: 'Remove the last N characters', help: 'Deletes the end of the text, whatever it is.' },
    args: [N('n', 'Nombre de caractères', 'Number of characters', 1)], example: { value: 'Vodka.', args: { n: 1 }, out: 'Vodka' } },
  { op: 'insert_at', group: 'cut', sheets: 'REPLACE(A2; position; 0; ",")', fr: { label: 'Insérer un caractère à des endroits précis', help: 'Insère un texte (une virgule, un point…) à une ou plusieurs positions, comptées depuis le début ou la fin. Ex. positions « 3, 6 ».' }, en: { label: 'Insert a character at exact places', help: 'Inserts a text (a comma, a dot…) at one or more positions counted from the start or the end. E.g. positions “3, 6”.' },
    args: [T('text', 'Texte à insérer', 'Text to insert', ','), T('positions', 'Positions (1 = au début)', 'Positions (1 = at the start)', '3'), B('fromEnd', 'Compter depuis la fin', 'Count from the end')], example: { value: '1599', args: { text: '.', positions: '3' }, out: '15.99' } },
  { op: 'delete_at', group: 'cut', sheets: 'REPLACE(A2; position; n; "")', fr: { label: 'Supprimer des caractères à une position', help: 'Supprime N caractères à partir d’une position.' }, en: { label: 'Delete characters at a position', help: 'Deletes N characters from a position.' },
    args: [N('position', 'Position de départ (1 = début)', 'Start position (1 = start)', 1), N('count', 'Nombre de caractères', 'Number of characters', 1)], example: { value: 'Vodka-Blanc', args: { position: 6, count: 1 }, out: 'VodkaBlanc' } },

  // ── numbers ──
  { op: 'number', group: 'number', sheets: '=A2/100', fr: { label: 'Calcul sur un nombre', help: 'Divise, multiplie, ajoute, soustrait ou arrondit un prix ou une quantité. Ex. centimes → euros : diviser par 100.' }, en: { label: 'Arithmetic on a number', help: 'Divides, multiplies, adds, subtracts or rounds a price or quantity. E.g. cents → euros: divide by 100.' },
    args: [{ key: 'action', type: 'choice', fr: 'Opération', en: 'Operation', default: 'divide', choices: [{ value: 'divide', fr: 'Diviser par', en: 'Divide by' }, { value: 'multiply', fr: 'Multiplier par', en: 'Multiply by' }, { value: 'add', fr: 'Ajouter', en: 'Add' }, { value: 'subtract', fr: 'Soustraire', en: 'Subtract' }, { value: 'round', fr: 'Arrondir à N décimales', en: 'Round to N decimals' }] }, N('value', 'Valeur', 'Value', 100)],
    example: { value: '1599', args: { action: 'divide', value: 100 }, out: '15.99' } },
  { op: 'decimal_point', group: 'number', sheets: 'VALUE(SUBSTITUTE(A2; ","; "."))', fr: { label: 'Virgule → point décimal', help: 'Réécrit un nombre « 12,99 € » ou « 1.234,50 » sous la forme 12.99 / 1234.5.' }, en: { label: 'Decimal comma → point', help: 'Rewrites a number such as “12,99 €” or “1.234,50” as 12.99 / 1234.5.' }, args: [],
    example: { value: '12,99 €', args: {}, out: '12.99' } },

  // ── url / slug / html ──
  { op: 'slugify', group: 'url', sheets: 'LOWER(REGEXREPLACE(A2; "[^a-z0-9]+"; "-"))', fr: { label: 'Transformer en slug', help: 'Minuscules, sans accents, mots reliés par des tirets : « Vodka Blanc 37,5% » → vodka-blanc-37-5.' }, en: { label: 'Make a slug', help: 'Lowercase, no accents, words joined by hyphens: “Vodka Blanc 37,5%” → vodka-blanc-37-5.' },
    args: [N('maxLength', 'Longueur maximale (0 = illimitée)', 'Maximum length (0 = unlimited)', 0, { optional: true })], example: { value: 'Vodka Blanc 37,5% Été', args: {}, out: 'vodka-blanc-37-5-ete' } },
  { op: 'strip_html', group: 'url', sheets: 'REGEXREPLACE(A2; "<[^>]+>"; "")', fr: { label: 'Retirer le HTML', help: 'Supprime les balises <p>, <br>… et garde le texte.' }, en: { label: 'Strip HTML', help: 'Removes <p>, <br>… tags and keeps the text.' }, args: [],
    example: { value: '<p>Vodka &amp; <b>citron</b></p>', args: {}, out: 'Vodka & citron' } },

  { op: 'clean_code', group: 'url', sheets: 'REGEXREPLACE(SUBSTITUTE(A2; "<li>"; "• "); "<[^>]+>"; "")',
    fr: { label: 'Nettoyer le code', help: 'Rend lisible un texte qui contient du code HTML (balises comme <p> et <li>, entités comme &amp; et &#8243;), par exemple la colonne « Body (HTML) ». Choisissez ensuite le mode.' },
    en: { label: 'Clean up the code', help: 'Makes a text that contains HTML code readable (tags such as <p> and <li>, entities such as &amp; and &#8243;), for example the “Body (HTML)” column. Then pick the mode.' },
    args: [{ key: 'mode', type: 'choice', fr: 'Mode', en: 'Mode', default: 'text', choices: [
      { value: 'text', fr: 'Texte seul', en: 'Text only', help: {
        fr: 'Retire toutes les balises et transforme les entités (&#8243;, &#038;, &amp;, &nbsp;…) en caractères. Chaque <li> devient une ligne « • … » ; <br> et chaque paragraphe, titre, liste ou ligne de tableau commencent une nouvelle ligne. Les scripts, styles et commentaires sont retirés avec leur contenu, de même que les espaces en double et les lignes vides. Une colonne HTML (comme « Body (HTML) ») n’affiche pas les sauts de ligne : choisissez-y plutôt « HTML propre ».',
        en: 'Removes every tag and turns the entities (&#8243;, &#038;, &amp;, &nbsp;…) into characters. Each <li> becomes a “• …” line; <br> and every paragraph, heading, list or table row start a new line. Scripts, styles and comments go with their content, and so do double spaces and empty lines. An HTML column (such as “Body (HTML)”) does not show line breaks: pick “Clean HTML” there instead.' } },
      { value: 'html', fr: 'HTML propre', en: 'Clean HTML', help: {
        fr: 'Garde seulement les balises de structure p, br, ul, ol, li, strong, em, h2 à h4, table, tr, th, td (b devient strong, i devient em, h1 devient h2, h5 et h6 deviennent h4). Retire les attributs (style, class…), les scripts, styles et commentaires, les autres balises (liens, images, div…) en gardant leur texte, puis les balises restées vides, sauf les cases de tableau. Transforme les entités en caractères, sauf <, > et &, qui restent écrits &lt;, &gt; et &amp;.',
        en: 'Keeps only the structure tags p, br, ul, ol, li, strong, em, h2 to h4, table, tr, th, td (b becomes strong, i becomes em, h1 becomes h2, h5 and h6 become h4). Removes attributes (style, class…), scripts, styles and comments, the other tags (links, images, div…) while keeping their text, then the tags left empty, except table cells. Turns entities into characters, except <, > and &, which stay written &lt;, &gt; and &amp;.' } },
    ] }],
    example: { value: '<h3>Caractéristiques</h3><ul><li><strong>Spectrum</strong> : 660-665nm</li><li>Puissance : 150W&#177;5%</li></ul>', args: { mode: 'text' }, out: 'Caractéristiques\n• Spectrum : 660-665nm\n• Puissance : 150W±5%' } },

  // ── columns ──
  { op: 'rename_column', group: 'column', sheets: '(renommer l’en-tête)', fr: { label: 'Renommer la colonne', help: 'Change le nom de la colonne (ses valeurs ne bougent pas).' }, en: { label: 'Rename the column', help: 'Changes the column name (its values stay).' }, args: [T('to', 'Nouveau nom', 'New name', 'title')] },
  { op: 'copy_column', group: 'column', sheets: '=A2 (nouvelle colonne)', fr: { label: 'Dupliquer la colonne', help: 'Crée une copie de la colonne : on peut ensuite la transformer sans toucher l’originale (ex. slug depuis le titre).' }, en: { label: 'Duplicate the column', help: 'Creates a copy of the column that can then be transformed without touching the original (e.g. a slug from the title).' }, args: [T('to', 'Nom de la copie', 'Name of the copy', 'slug')] },
  { op: 'add_column', group: 'column', sheets: '="valeur" (nouvelle colonne)', fr: { label: 'Ajouter une colonne', help: 'Ajoute une colonne avec une valeur fixe.' }, en: { label: 'Add a column', help: 'Adds a column with a fixed value.' }, args: [T('to', 'Nom de la colonne', 'Column name', 'brand'), T('text', 'Valeur', 'Value', 'Delhaize', { optional: true })] },
  { op: 'join_columns', group: 'column', sheets: 'TEXTJOIN(" "; TRUE; A2; B2)', fr: { label: 'Assembler plusieurs colonnes', help: 'Crée une colonne en collant le contenu de plusieurs colonnes (ex. marque + nom).' }, en: { label: 'Join several columns', help: 'Creates a column by joining the content of several columns (e.g. brand + name).' },
    args: [{ key: 'columns', type: 'columns', fr: 'Colonnes à assembler', en: 'Columns to join' }, T('sep', 'Séparateur', 'Separator', ' ', { default: ' ', optional: true }), T('to', 'Nom de la nouvelle colonne', 'New column name', 'title')] },
  { op: 'words_from', group: 'column', sheets: 'REGEXEXTRACT(B2; "^\\S+")',
    fr: { label: 'Copier les premiers mots d’une autre colonne', help: 'Remplit cette colonne avec le début d’une autre (ex. la marque = premier mot du titre). Pour les marques de plusieurs mots, indiquez-les dans la liste (ou choisissez le nombre de mots sur une ligne d’exemple) : la liste est ensuite appliquée à toutes les lignes.' },
    en: { label: 'Copy the first words of another column', help: 'Fills this column with the start of another one (e.g. the brand = first word of the title). For multi-word brands, put them in the list (or pick the word count on an example row): the list is then applied to every row.' },
    args: [{ key: 'from', type: 'column', fr: 'Copier depuis la colonne', en: 'Copy from column' }, N('count', 'Nombre de mots par défaut', 'Default number of words', 1), { key: 'known', type: 'longtext', fr: 'Noms de plusieurs mots (un par ligne)', en: 'Multi-word names (one per line)', placeholder: 'Under Armour\nNew Balance', optional: true }, B('onlyEmpty', 'Seulement si la case est vide', 'Only if the cell is empty')] },
  { op: 'template', group: 'column', sheets: '=B2 & " - " & A2',
    fr: { label: 'Composer avec d’autres colonnes', help: 'Écrit un texte où vous placez ce que vous voulez : {NomDeColonne} insère le contenu d’une colonne, {this} le contenu actuel de la case. Ex. « {Vendor} - {this} ».' },
    en: { label: 'Compose from other columns', help: 'Writes a text where you place what you want: {ColumnName} inserts a column’s content, {this} the current content of the cell. E.g. “{Vendor} - {this}”.' },
    args: [{ key: 'text', type: 'longtext', fr: 'Texte (avec {colonne} et {this})', en: 'Text (with {column} and {this})', placeholder: '{Vendor}-{this}' }] },
  { op: 'delete_column', group: 'column', sheets: '(supprimer la colonne)', fr: { label: 'Supprimer la colonne', help: 'Retire la colonne du fichier avant la conversion.' }, en: { label: 'Delete the column', help: 'Removes the column from the file before conversion.' }, args: [] },
];

/** One-click recipes: a short list of edits for the situations seen most often. */
export type EditPreset = { id: string; fr: string; en: string; nl?: string; es?: string; hintFr: string; hintEn: string; hint?: Partial<Record<EditLang, string>>; needsColumn: true; edits: { op: string; args: Record<string, EditArg>; suffixColumn?: string }[] };
export const EDIT_PRESETS: EditPreset[] = [
  { id: 'cents_to_euros', fr: 'Prix en centimes → euros', en: 'Prices in cents → euros', hintFr: '1599 devient 15.99', hintEn: '1599 becomes 15.99', needsColumn: true, edits: [{ op: 'number', args: { action: 'divide', value: 100 } }] },
  { id: 'pipes_to_spaces', fr: 'Retirer les « | » d’un titre', en: 'Remove the “|” from a title', hintFr: 'Eristoff | Vodka | Blanc → Eristoff Vodka Blanc', hintEn: 'Eristoff | Vodka | Blanc → Eristoff Vodka Blanc', needsColumn: true, edits: [{ op: 'join_segments', args: { sep: '|', with: ' ' } }] },
  { id: 'dedupe_title', fr: 'Retirer les parties et mots répétés', en: 'Remove repeated parts and words', hintFr: 'Vodka | Blanc | Vodka → Vodka | Blanc', hintEn: 'Vodka | Blanc | Vodka → Vodka | Blanc', needsColumn: true, edits: [{ op: 'dedupe_segments', args: { sep: '|' } }] },
  { id: 'slug_from_title', fr: 'Créer un slug propre depuis cette colonne', en: 'Create a clean slug from this column', hintFr: 'Copie la colonne puis la transforme en slug (nom-sans-accents)', hintEn: 'Copies the column then turns it into a slug (name-without-accents)', needsColumn: true, edits: [{ op: 'copy_column', args: { to: '{col}_slug' } }, { op: 'slugify', args: {}, suffixColumn: '_slug' }] },
  { id: 'values_after_colon_joined', fr: 'Valeurs après « : » reliées par « - »', en: 'Values after “:” joined with “-”', hintFr: 'Couleur du produit : Aurora Coffee / Magic Mauve / Gum → Aurora Coffee-Magic Mauve-Gum', hintEn: 'Colour: Aurora Coffee / Magic Mauve / Gum → Aurora Coffee-Magic Mauve-Gum', needsColumn: true, edits: [{ op: 'keep_after', args: { text: ':' } }, { op: 'join_segments', args: { sep: '/', with: '-' } }] },
  { id: 'trim_all', fr: 'Nettoyer les espaces de cette colonne', en: 'Clean the spaces of this column', hintFr: 'Retire les espaces inutiles', hintEn: 'Removes useless spaces', needsColumn: true, edits: [{ op: 'trim', args: {} }] },
];

// ── Dutch and Spanish texts, merged into the objects above ──
type CatalogTexts = {
  groups: Record<string, string>;
  ops: Record<string, { label: string; help: string; args?: Record<string, string>; choices?: Record<string, Record<string, string>>; choiceHelp?: Record<string, Record<string, string>> }>;
  presets: Record<string, { label: string; hint: string }>;
};
const TRANSLATIONS: Record<'nl' | 'es', CatalogTexts> = { nl: EDIT_CATALOG_NL, es: EDIT_CATALOG_ES };
for (const p of EDIT_PRESETS) p.hint = { fr: p.hintFr, en: p.hintEn };
for (const lang of ['nl', 'es'] as const) {
  const tr = TRANSLATIONS[lang];
  for (const g of EDIT_GROUPS) g[lang] = tr.groups[g.id];
  for (const e of EDIT_CATALOG) {
    const o = tr.ops[e.op];
    if (!o) continue; // a missing translation shows English (the parity test fails first)
    e[lang] = { label: o.label, help: o.help };
    for (const a of e.args) {
      a[lang] = o.args?.[a.key];
      for (const c of a.choices ?? []) {
        c[lang] = o.choices?.[a.key]?.[c.value];
        if (c.help) c.help[lang] = o.choiceHelp?.[a.key]?.[c.value];
      }
    }
  }
  for (const p of EDIT_PRESETS) {
    const t = tr.presets[p.id];
    if (!t) continue;
    p[lang] = t.label;
    p.hint![lang] = t.hint;
  }
}
