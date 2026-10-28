# SourceAdapter — Design (Phase 5, conception uniquement)

> Ce document décrit **le contrat** que suivront les futurs adaptateurs de
> source. Aucun code d'adaptateur n'est écrit dans cette phase. L'objectif :
> figer l'abstraction avant l'implémentation, garantir que WooCommerce local,
> Wix, Shopify, BigCommerce et Shopware suivent le **même** pipeline interne,
> et éviter la dérive vers des « Importer » spécifiques par plateforme qui
> contourneraient le moteur.

## 1. Abstractions

### 1.1 `CredentialProvider`

Une interface qui **isole** la manipulation des secrets. Les adaptateurs ne
lisent jamais un `process.env`, un fichier `.env`, ni un table Supabase en
direct. Le `CredentialProvider` sait aller chercher les secrets là où ils
vivent réellement pour cette session (Supabase Vault via Edge Function pour
les APIs distantes, ou fichier local pour un WordPress Studio).

```ts
export type PlatformKey =
  | 'woocommerce' | 'shopify' | 'wix' | 'bigcommerce' | 'shopware' | 'bigbuy' | 'presta' | string;

export type SourceScope = 'LOCAL_REAL' | 'REMOTE_API' | 'FILE' | 'FIXTURE';

export type CredentialRequest = {
  platform: PlatformKey;
  scope: SourceScope;               // routes: local vs remote vs offline fixture
  instance?: string;                // e.g. site name for WordPress Studio, storefront id for Shopify
  scopes?: string[];                // read-only scopes; adapter names what it needs
};

export type CredentialResult = {
  // OPAQUE token or SDK handle. The provider MAY return a callable client
  // (fully-configured Shopify Admin API client, WC REST fetcher, …) so the
  // adapter never handles raw keys. Callers must not stringify this.
  handle: unknown;
  // The credential's origin — never a value, only how it was obtained.
  origin: 'wordpress-studio-mcp' | 'edge-function' | 'env-var' | 'file' | 'anonymous';
  // Optional expiry hint if the handle is a short-lived token.
  expiresAt?: string;
};

export interface CredentialProvider {
  request(req: CredentialRequest): Promise<CredentialResult>;
}
```

**Règles** :
- Aucun credential brut ne quitte le `CredentialProvider` (retourner un
  client pré-configuré est préféré à retourner une clé).
- Aucun credential ne finit dans une fixture, un log, un rapport, une erreur.
- Les tests unitaires reçoivent un `CredentialProvider` factice ; ils ne
  tapent jamais une API distante.

### 1.2 `SourceConnection`

Ce que sait faire un adaptateur avec son handle : lister des ressources et
récupérer une ressource unique. Volontairement minimaliste — pas de mutations.

```ts
export type SourceListPage<T = unknown> = { items: T[]; nextCursor?: string };

export interface SourceConnection {
  platform: PlatformKey;
  scope: SourceScope;
  // Human-readable id for logs and reports (e.g. "woocommerce-test:8881",
  // "shopify:my-store", "wix:studio-01"). NEVER contains a credential.
  label: string;

  listProducts(input?: { cursor?: string; limit?: number }): Promise<SourceListPage>;
  getProduct(id: string): Promise<unknown>;

  // Optional — availability declared by the adapter. Absent = not supported.
  listCustomers?(input?: { cursor?: string; limit?: number }): Promise<SourceListPage>;
  getCustomer?(id: string): Promise<unknown>;
  listOrders?(input?: { cursor?: string; limit?: number }): Promise<SourceListPage>;
  getOrder?(id: string): Promise<unknown>;

  // Health check the CLI/UI can call before a long import.
  ping(): Promise<{ ok: boolean; reason?: string; latencyMs?: number }>;
  close?(): Promise<void>;
}
```

**Règle** : `SourceConnection` retourne des **données brutes** — c'est-à-dire
la forme naturelle de la source (CSV row, JSON object, XML element). Elle ne
convertit RIEN vers le canon.

### 1.3 `SourceRecord` + `SourceCollection`

Enveloppes qui portent la **provenance native** (URL/endpoint/fichier
d'origine, page/curseur) autour d'une donnée brute.

```ts
export type SourceRecord<T = unknown> = {
  platform: PlatformKey;
  scope: SourceScope;
  raw: T;                       // verbatim source object (CSV row, JSON, XML node…)
  sourceUrl?: string;           // ressource d'origine si connue
  fetchedAt: string;            // ISO
  page?: { cursor?: string; index?: number };
};

export type SourceCollection<T = unknown> = {
  platform: PlatformKey;
  scope: SourceScope;
  records: AsyncIterable<SourceRecord<T>>; // streaming — pas de charge mémoire
  // Optional schema hint the adapter can emit (columns for CSV, field list
  // for JSON…). Consumed by Structural/Semantic Recognition later.
  schema?: { fields: Array<{ name: string; type?: string; example?: unknown }> };
};
```

### 1.4 `SourceAdapter`

L'interface qu'implémente chaque plateforme (une classe / un module par
plateforme). Elle **compose** `CredentialProvider` + `SourceConnection`.

```ts
export interface SourceAdapter {
  platform: PlatformKey;
  supportedScopes: SourceScope[];   // e.g. WC: ['LOCAL_REAL','REMOTE_API','FILE','FIXTURE']
                                     //      Shopify: ['REMOTE_API','FILE','FIXTURE']

  // Open a connection using the requested scope. The CredentialProvider is
  // injected — adapters never construct their own secrets access.
  connect(input: {
    scope: SourceScope;
    instance?: string;
    credentials: CredentialProvider;
    fetchImpl?: typeof fetch;       // injectable for tests
  }): Promise<SourceConnection>;

  // Stream a collection of raw records without touching the canon yet.
  fetchProducts(conn: SourceConnection, opts?: { limit?: number }): Promise<SourceCollection>;

  // OPTIONAL: a normaliser hint the adapter can offer — a shallow shape hint
  // that Structural Recognition can use to decide how to build products,
  // variants, options, images from the raw records. This is NOT the canon.
  describe?(): {
    productLayout: 'one-row-per-product' | 'grouped-by-key' | 'row-typed' | 'nested-json';
    variantLayout: 'siblings' | 'child-rows' | 'nested-array';
    imageLayout: 'siblings' | 'delimited-list' | 'nested-array';
  };
}
```

**Ce que `SourceAdapter` NE fait PAS** :
- Il n'écrit pas dans le canon (c'est le rôle du `StructuralRecognizer` +
  `SemanticRecognizer`, Phases 6-7).
- Il ne juge pas les valeurs (pas de scoring — Phase 7).
- Il ne pose pas de question à l'utilisateur (Phase 8-9).
- Il ne mémorise rien (Phase 13).

### 1.5 `StructuralRecognition` (contrat vide en Phase 5)

Interface que la Phase 6 implémentera. Prend un `SourceCollection` (records
bruts + schema hint) et produit une **arborescence structurée**
(Product → Variant → Option/Image/…), toujours sans se prononcer sur les
champs sémantiques.

```ts
export interface StructuralRecognizer {
  recognize(coll: SourceCollection): Promise<StructuredCollection>;
}

// Product/Variant/Option/Image encore anonymes — les valeurs restent brutes ;
// seule la RELATION est déterminée à ce stade.
export type StructuredNode = {
  kind: 'product' | 'variant' | 'option' | 'image' | 'attribute' | 'category' | 'meta';
  raw: unknown;
  children?: StructuredNode[];
  provenance: { platform: PlatformKey; sourceField?: string };
};

export type StructuredCollection = { nodes: StructuredNode[] };
```

### 1.6 `SemanticRecognition` (contrat vide en Phase 5)

Interface que la Phase 7 implémentera. Prend `StructuredCollection` + une
politique (seuils Phase 8) et produit un mapping candidats → `CanonProvenance`
prêt à alimenter un `CanonProduct[]`. Aucune décision silencieuse : les
ambiguïtés sont émises comme `Question` (Phase 9).

## 2. Portée par plateforme

### 2.1 WooCommerce (Priorité 1)

| Scope | Chemin | Statut cette session |
|---|---|---|
| `LOCAL_REAL` | WordPress Studio via **MCP** (`wp_cli`, `wc product list --format=json`) | ✅ **vérifié** (utilisé Phase 0 sur `woocommerce-test`) |
| `REMOTE_API` | WooCommerce REST API `/wp-json/wc/v3/products` avec `consumer_key`/`consumer_secret` | Prévu Phase 5 impl |
| `FILE` | CSV via `parseWooModern` / `parseWooLegacy` existant | ✅ déjà en prod |
| `FIXTURE` | JSON figé dans `test/fixtures/woocommerce/` | À créer en implémentation |

**Réutilisation** : le `SourceAdapter` WooCommerce (`REMOTE_API` et
`LOCAL_REAL`) transforme les records JSON en un **CSV virtuel** (`Table`
compatible avec `parseWooModern`) — c'est le choix conservateur retenu en
Phase 1 §12. Alternative future : parseur `parseWooRest` direct branché après
`StructuralRecognizer`.

### 2.2 Wix (Priorité 2)

| Scope | Chemin | Statut cette session |
|---|---|---|
| `LOCAL_REAL` | Compte Wix configuré localement + credentials Supabase | ⚠️ **non vérifiable dans cette session** (pas d'accès Vault depuis ce process) |
| `REMOTE_API` | Wix Stores API v3 `/stores/v3/products/query` avec API key / access token | Pareil |
| `FILE` | CSV via `parseWixProducts` existant | ✅ déjà en prod |
| `FIXTURE` | JSON figé | À créer |

**Note** : le compte est disponible localement, la configuration API existe,
mais **ce session Claude Code n'a pas d'accès direct au Vault Supabase**
pour vérifier automatiquement. La vérification live sera faite au moment de
l'implémentation Phase 5, via l'Edge Function proxy (voir §3).

### 2.3 Shopify (Priorité 3)

| Scope | Chemin | Statut |
|---|---|---|
| `REMOTE_API` | Admin API GraphQL `2026-01` `/admin/api/{version}/graphql.json` avec Admin API access token | ⚠️ crédentials dans Vault Supabase (non testable ici) |
| `FILE` | CSV via `parseShopifyProducts` existant | ✅ déjà en prod |
| `FIXTURE` | JSON figé | À créer |

### 2.4 BigCommerce (Priorité 4)

| Scope | Chemin | Statut |
|---|---|---|
| `REMOTE_API` | Catalog API v3 `/stores/{store_hash}/v3/catalog/products` avec `X-Auth-Token` | ⚠️ credentials dans Vault Supabase (non testable ici) |
| `FILE` | CSV via `parseBigCommerceProducts` existant | ✅ déjà en prod |
| `FIXTURE` | JSON figé | À créer |

### 2.5 Shopware (Priorité 5) — **BLOQUÉ, action manuelle requise**

Aucun credential Shopware confirmé disponible. Avant que l'adaptateur puisse
être conçu concrètement, il faut identifier la méthode officielle utilisée
par le compte Shopware. Deux mécanismes officiels documentés par Shopware :

1. **Shopware 6 Store API (public, non-admin)** — pour catalogues côté client.
   Base URL du storefront + `sw-access-key` (clé publique) suffisent pour
   lister produits/catégories publics. Convient pour un adaptateur en lecture
   seule côté catalogue publié.
2. **Shopware 6 Admin API (OAuth2 client credentials)** — pour données
   privées (stock, prix par client, brouillons). Requiert la création d'un
   « Integration » dans le back-office Shopware : Settings → System →
   Integrations → New integration → un nom + rôles → génère un
   `access_key_id` + `secret_access_key` (paire montrée UNE seule fois).

**Ce que l'utilisateur doit faire manuellement** :

| Étape | Où | Ce qu'Eloshon Converter utilisera ensuite |
|---|---|---|
| 1. Décider public catalog vs admin | selon besoin | dictate le scope requis (public → `sw-access-key`, admin → OAuth2 client credentials) |
| 2. Se connecter au back-office Shopware du compte | `https://<votre-domaine>/admin` | — |
| 3a. Public : Settings → Sales Channels → sélectionner un Sales Channel API-enabled → copier l'`Access key` (public) | Sales Channels | `sw-access-key` |
| 3b. Admin : Settings → System → Integrations → Add integration → attribuer les rôles (au moins « Product: Read », « Category: Read ») → sauvegarder | Integrations | `access_key_id` + `secret_access_key` (à copier immédiatement — non ré-affiché) |
| 4. Communiquer à Eloshon la **base URL** du storefront (`https://…`), le mode (`public` ou `admin`), et les credentials via **le Vault Supabase du projet** (pas dans le chat, pas dans un fichier du dépôt) | Vault Supabase | Le `CredentialProvider` les récupérera via l'Edge Function |
| 5. Fournir le `sales_channel_id` si mode admin, pour scoper la lecture aux produits publiés | back-office | scope de la lecture |

Une fois ces informations dans le Vault, la Phase 5 implémentation pourra
créer l'adaptateur Shopware exactement comme les autres — aucune exception
architecturale.

**Note d'implémentation** (pour plus tard) : Shopware Admin API v6 utilise
un endpoint `/api/product` avec pagination via `limit`/`page` et un
`total-count-mode` demandable. Le token OAuth se rafraîchit via
`/api/oauth/token` avec `grant_type=client_credentials`. Ne pas hardcoder
la version d'API dans l'adaptateur (Shopware ne versionne pas ses endpoints
mais patche via en-têtes `sw-api-compatibility`).

## 3. Routage des credentials — pattern Edge Function

Modèle **identique** à celui déjà en place dans Eloshon Scraper
(`C:\eloshon-scraper\core\edge-client.mjs`) — jamais réinventé :

```
Converter renderer/main
   │
   │  { license, action, args }        ← jamais de secret plateforme
   ▼
Edge Function Supabase (Deno)
   │
   │  lit le secret plateforme depuis le Vault
   │  appelle Shopify/BigCommerce/Wix/Shopware
   │  renvoie le résultat normalisé
   ▼
Converter renderer/main
```

Bénéfices :
- Le Converter (Electron) **n'a jamais** de clé plateforme.
- La licence utilisateur gère la quota et la facturation (comme Scraper).
- Les tests unitaires n'exigent aucun accès distant (`fetchImpl` injectable).
- Un unique choke-point pour audit et rotation des clés.

Applicabilité :
- **Shopify, BigCommerce, Wix REST, Shopware Admin API** → passent par
  Edge Function.
- **WordPress Studio (WooCommerce local)** → connexion locale directe via MCP,
  aucun secret plateforme (MCP est déjà autorisé par l'utilisateur).
- **CSV/XLSX/XML/JSON fichier local** → aucun credential.

## 4. Ce que la Phase 5 implémentation devra livrer

Ordre recommandé (chaque étape testée, sans régresser les 62 tests / 25 goldens
actuels) :

1. `core/src/adapters/types.ts` — les interfaces ci-dessus (types purs, zéro
   runtime).
2. `core/src/adapters/credential-provider.ts` — implémentation nulle
   (`AnonymousCredentialProvider`) + implémentation edge-function (calquée sur
   le Scraper).
3. `core/src/adapters/woocommerce/` — adaptateur WordPress Studio d'abord
   (MCP → CSV virtuel Woo Modern), puis REST distant plus tard. Tests avec
   fixtures locales figées depuis `woocommerce-test`.
4. `core/src/adapters/wix/`, `shopify/`, `bigcommerce/` — quand credentials
   validés en live.
5. `core/src/adapters/shopware/` — **seulement après** que l'utilisateur ait
   fourni les credentials au Vault selon §2.5.
6. Chaque adaptateur : un fichier fixture JSON (petit, anonymisé) + tests
   contract-only ne touchant jamais le réseau. Tests d'intégration live isolés
   dans `test/integration/` skippés par défaut (variable d'environnement).

## 5. Critères d'invariants (à préserver après Phase 5)

- Les 62 tests unitaires actuels restent verts.
- Les 25 golden files CSV restent byte-identiques.
- Aucun secret n'apparaît dans un log, un rapport, une fixture, un test.
- Le pipeline CSV existant fonctionne **sans** aucun adaptateur (adapter =
  couche ADDITIVE qui construit une `Table` compatible pour les parseurs
  actuels, ou alimente directement le nouveau `StructuralRecognizer`).
- `CredentialProvider` reste injectable ; jamais construit implicitement par
  un adaptateur.
