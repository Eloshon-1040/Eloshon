-- =========================================================================
-- recipes.link_filter — learned listing-link scope: which discovered links
-- belong to the collection being scraped. Captured client-side in the same
-- gesture as manual_selectors, sits NEXT TO internal_api/manual_selectors and
-- follows the same versioned/shared lifecycle. The local domain-profile
-- mirrors this jsonb verbatim (no conversion on sync); the client owns the
-- shape (include/exclude patterns, scopeToCollection, origin, sample_url).
-- v1 is fail-open: an unmatched link is kept and counted in report.scopedOut.
-- RLS needs no change: read_shared_recipes filters rows (status='shared') and
-- the authenticated grant is table-level, so the new column is covered.
-- =========================================================================
alter table public.recipes
  add column if not exists link_filter jsonb;

comment on column public.recipes.link_filter is
  'Learned listing-link scope (client-owned jsonb: include/exclude patterns, scopeToCollection, origin, sample_url) — captured with manual_selectors, shared like internal_api.';
