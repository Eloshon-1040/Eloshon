-- =========================================================================
-- Seed the lidl.be internal_api recipe (reference recipe, Etape 3).
-- Mirrors core/recipes/lidl-be.json verbatim — the jsonb IS the recipe the
-- client replays (see core/internal-api.mjs). Validated live 2026-09-25
-- (campaign a10103434: 114/114 products, 3 pages, plain HTTP, no cookies).
-- Idempotent: re-running refreshes the recipe in place.
-- =========================================================================

-- FK target first (recipes.host references domains.host).
insert into public.domains (host, country, locale, needs_browser, needs_unlock)
values ('lidl.be', 'BE', 'nl_BE', false, false)
on conflict (host) do nothing;

insert into public.recipes (host, version, internal_api, fields_available, status, locked, country, created_by)
values (
  'lidl.be',
  1,
  $lidl_recipe$
{
  "domain": "lidl.be",
  "type": "internal_api",
  "base_url": "https://www.lidl.be",
  "endpoint_tpl": "https://www.lidl.be/q/api/search?assortment=BE&locale={lang}_BE&version=v2.0.0&campaign={campaign}&automatedCampaign={campaign}&fetchsize={fetchsize}&offset={offset}",
  "method": "GET",
  "static_headers": {
    "Accept": "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  "vars": {
    "campaign": {
      "source": "url",
      "pattern": "/a(\\d+)(?:[/?#]|$)"
    },
    "lang": {
      "source": "url",
      "pattern": "/([a-z]{2})-BE/"
    }
  },
  "pagination": {
    "type": "offset",
    "param": "offset",
    "size_param": "fetchsize",
    "size": 48,
    "start": 0,
    "total_json_path": "numFound"
  },
  "json_path": "items",
  "field_map": {
    "name": "gridbox.data.fullTitle",
    "price": "gridbox.data.price.price",
    "listPrice": "gridbox.data.price.oldPrice",
    "currency": "gridbox.data.price.currencyCode",
    "sku": "gridbox.data.erpNumber",
    "image": "gridbox.data.image",
    "url": "gridbox.data.canonicalPath",
    "brand": "gridbox.data.brand.name",
    "description": "gridbox.data.keyfacts.supplementalDescription",
    "category": "gridbox.data.category"
  },
  "notes": "Lidl BE campaign/search API — no cookies, no dynamic headers, no JS. Accept MUST stay */* (application/json → 406). campaign id = the a<ID> suffix of /c/... URLs; locale is rebuilt as {lang}_BE from the URL's nl-BE|fr-BE segment (API wants an underscore). fetchsize is server-capped at ~60/request, so 48 keeps offset += size == items served. A &q=<term> search may answer 301 with a JSON redirectURL — campaign queries answer 200 directly. canonicalPath/canonicalUrl are BOTH site-relative (no absolute product URL anywhere in the payload); cutoutimageV2 is always empty — never map it. ians[] are Lidl IANs (6-9 digits), NOT EANs — never map to gtin. Validated live 2026-09-25 (114/114 products, 3 pages)."
}
$lidl_recipe$::jsonb,
  array['name','price','listPrice','currency','sku','image','url','brand','description','category'],
  'shared',
  true,          -- reference recipe: never auto-deprecated
  'BE',
  'eloshon'
)
on conflict (host, version) do update set
  internal_api     = excluded.internal_api,
  fields_available = excluded.fields_available,
  status           = excluded.status,
  locked           = excluded.locked,
  country          = excluded.country,
  created_by       = excluded.created_by,
  last_verified    = now();
