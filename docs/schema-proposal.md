# Schéma Supabase — PROPOSITION (NON APPLIQUÉE) — révision 2

> Projet cible : **Convert | Scrap Apps** (`ilaakzwnfgzkinyygevv`).
> **SQL complet et canonique** : [`supabase/migrations/20260918120000_shared_profile_and_quota.sql`](../supabase/migrations/20260918120000_shared_profile_and_quota.sql).
> Ce document explique les choix ; le fichier de migration fait foi.
> **Rien n'est appliqué sans ton second accord** (`apply_migration`). Date : 2026-09-18.

## Principes (inchangés)

- Séparation stricte : aucune donnée produit / prix / URL précise scrapée / identité client.
- `client_hash = HMAC(license, pepper)` — non réversible.
- Seuils **en base** (`app_config`), relus côté serveur ; rien de figé dans le code.
- Écriture réservée au `service_role` (Edge Function).

## Réponses à tes 7 corrections + 2 points mineurs

| # | Correction | Ce qui change dans le schéma |
|---|---|---|
| **1** | Contradiction de promotion | **Un seul mécanisme : au niveau de la recette** (`recipes.status='shared'`). `domains.promoted` **supprimé**. La visibilité du domaine dérive de l'existence d'une recette partagée (`read_domains_with_shared_recipe` : `EXISTS recipe shared`). `recipes.status='shared'` pour la lecture des recettes. **Pourquoi la recette** : la promotion est méritée par une *version de recette* qui a réussi chez ≥ `promote_min_clients` clients ; un domaine peut porter à la fois une recette `deprecated` et une `shared`. Le domaine n'est que métadonnée. |
| **2** | Unité de comptage | Unité interne unique = **crédit de déblocage Eloshon**, dérivé de `app_config.credit_coeff`. `provider_calls` stocke **les deux** : `provider_units` (brut fournisseur : Scrapfly 1/30, BD 1 requête, FC 1/5) **et** `eloshon_credits` (décompté). |
| **3** | Consommation cumulée | Nouvelle table **`account_usage`** (`account_id`, `period_start`, `eloshon_credits_used`, `provider_units_used`, `requests`) — évite d'agréger `provider_calls` à chaque vérification. |
| **4** | Réinitialisation | Dans la RPC **`check_quota`** (appelée par l'Edge Function au 1er appel de la période) : si `accounts.period_start < current_period()` → reset `period_start`, nouvelle ligne `account_usage` à 0. Atomique côté serveur. |
| **5** | Choix du fournisseur | `domains.best_provider_measured_at` (date de dernière mesure) + `domains.provider_stats` jsonb (coût/succès/durée **par fournisseur**) → réévaluation si le site change de protection. `best_provider` seul ne suffit plus. |
| **6** | Pays et langue | `domains.country` (pays attendu, ex `BE`) **distinct** de `domains.locale` (ex `fr_BE`). `recipes.country` optionnel si recette spécifique à une version pays. `run_feedback.country_used` + `country_mismatch`. |
| **7** | Protection des recettes | `app_config.max_feedback_per_account_per_day` (plafond de remontées, index `run_feedback(client_hash,created_at)`) ; `accounts.blocked` + `blocked_reason` (bloquer un compte) ; **`recipes.locked`** → les recettes `created_by='eloshon'` verrouillées ne sont **jamais** déclassées automatiquement (le déclassement serveur ignore `locked=true`). |
| min.1 | Lecture d'`app_config` | Colonne **`client_visible`** ; policy `read_config_public` n'expose que `client_visible=true`. `credit_coeff`, `provider_order`, seuils, etc. → `client_visible=false` (jamais exposés au client). |
| min.2 | Trigger `updated_at` | Fonction `set_updated_at()` + triggers sur `app_config` et `account_usage`. |

## Les 7 tables

| Table | Rôle | Écriture |
|---|---|---|
| `app_config` | seuils & config serveur (dont `client_visible`) | service_role |
| `domains` | profil partagé (+ `provider_stats`, `best_provider_measured_at`, `country`≠`locale`) | service_role |
| `recipes` | recettes versionnées (+ `locked`, `internal_api` pour A1) | service_role |
| `run_feedback` | retours anonymisés (+ `country_mismatch`) | service_role |
| `accounts` | licences + quota + `blocked` | service_role |
| `account_usage` | consommation cumulée par période | service_role |
| `provider_calls` | comptabilité `provider_units` + `eloshon_credits` | service_role |

## Cascade & quota — comment ça s'articule (côté serveur)

1. Edge Function reçoit `{license, url, estimate}`.
2. `check_quota(license, estimate)` → reset période si besoin, renvoie `{allowed, remaining, ...}`. Si `blocked`/quota dépassé → refus clair, repli local.
3. Pays déduit de l'URL → imposé au fournisseur (`enforce_url_country`). Version régionale divergente → `country_mismatch=true` + alerte.
4. Cascade `provider_order` (court-circuitée par `domains.best_provider`), arrêt après `max_attempts_per_site` échecs + diagnostic.
5. `record_provider_call(...)` → journalise `provider_units`+`eloshon_credits`, incrémente `account_usage` (succès + `billing='eloshon'` uniquement).
6. Mesure par fournisseur écrite dans `domains.provider_stats` + `best_provider_measured_at`.

## `app_config` — contenu initial

`recipe_validity_days=90`, `promote_min_clients=3`, `deprecate_after_fails=3`,
`max_attempts_per_site=3`, `max_feedback_per_account_per_day=200`, `enforce_url_country=true`,
`provider_order=["local","firecrawl_normal","scrapfly_datacenter","brightdata","scrapfly_asp"]`,
`credit_coeff` (ratios mesurés), `credit_margin=1.5`. Tous en `client_visible=false`.

## Révision 3 — bloquant + décisions + points mineurs

| Sujet | Changement |
|---|---|
| **Bloquant RPC** | Ajout `grant execute on check_quota / record_provider_call to service_role` (après les `revoke`). Vérifié par le test #4. |
| **Décision 1 — barème** | `credit_coeff` = **ratios mesurés** vs page Firecrawl-normal : `firecrawl_normal:1, firecrawl_stealth:5, scrapfly_datacenter:0.18, scrapfly_asp:5.4, brightdata:2.7`. Marge séparée `credit_margin=1.5`. Débit serveur = `max(1, ceil(coeff × marge))` → FC-normal 2, FC-stealth 8, SF-dc 1, **SF-asp 9, BD 5** (rapport cohérent avec les coûts réels). Règle documentée dans les `description`. |
| **Décision 2 — lecture** | Policies `authenticated` **conservées** (forward-compatible). Modèle recommandé **(b)** : client ↔ Edge Function seule ; policies inertes alors. À confirmer avant l'Edge Function. |
| **Décision 3 — Firecrawl** | Placé en **position 2** du `provider_order` : quota gratuit 1000/mois, échecs à 0 crédit ; profil de domaine route l'Akamai connu directement vers Bright Data. |
| **Mineur — verrou quota** | `pg_advisory_xact_lock(hashtext(license))` dans `check_quota` et `record_provider_call` → sérialise les opérations concurrentes d'un même compte. Option stricte (réservation/réconciliation) disponible si besoin de zéro dépassement. |
| **Mineur — EXISTS/ligne** | `read_domains_with_shared_recipe` s'appuie sur l'index partiel `recipes_shared_idx (host) where status='shared'` → lookup par `host`, pas de scan. Escalade possible : colonne `domains.has_shared_recipe` maintenue par la fonction de promotion si la table grossit beaucoup. |
| **Défense en profondeur** | `grant select` explicite à `authenticated` sur `app_config/domains/recipes` ; `revoke all` pour `anon,authenticated` sur `run_feedback/accounts/account_usage/provider_calls`. |
