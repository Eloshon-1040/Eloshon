-- =========================================================================
-- recipes.manual_selectors — human-designated field selectors (Thunderbit-style,
-- last resort). Sits NEXT TO internal_api, same versioned/shared lifecycle, so a
-- site a user taught once needs no intervention for the next users.
--   {
--     "card": "<css for the repeating product card>",
--     "fields": {
--       "name":  {"selector":"...","attr":null},   -- attr null => textContent
--       "price": {"selector":"...","attr":null},
--       "image": {"selector":"...","attr":"src"},
--       "url":   {"selector":"a","attr":"href"}
--     },
--     "pagination": {"mode":"next-button|load-more|scroll|none","selector":"...","max_pages":null},
--     "origin": "manual|ai-assisted",
--     "sample_url": "<category page the user designated on>"
--   }
-- The local domain-profile mirrors this jsonb verbatim (no conversion on sync); its
-- own lifecycle counters map to the existing recipes columns
-- (success_count/fail_count/consecutive_fails/status/last_verified/version).
-- =========================================================================
alter table public.recipes
  add column if not exists manual_selectors jsonb;

comment on column public.recipes.manual_selectors is
  'Human-designated field selectors (card, fields{selector,attr}, pagination{mode,selector}) — last-resort extraction, shared like internal_api.';
