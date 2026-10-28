-- Eloshon Scraper — Shared domain profile (Etape 3) + provider quota/accounting (Etape 2)
-- Applied 2026-09-18 (recorded version 20260918181744). Reviewed round 2 + 7 corrections.
-- Project: Convert | Scrap Apps (ilaakzwnfgzkinyygevv)
--
-- Strict separation: no product, no price, no exact scraped URL, no client identity.
-- Writes reserved to service_role (Edge Function). Thresholds live in app_config.

-- =========================================================================
-- Helpers
-- =========================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.current_period()
returns date language sql stable as $$
  select date_trunc('month', now())::date;
$$;

-- =========================================================================
-- 1. app_config — server-side thresholds (not hardcoded)
--    client_visible gates what the desktop client may read (minor point #1).
-- =========================================================================
create table public.app_config (
  key            text primary key,
  value          jsonb not null,
  description    text,
  client_visible boolean not null default false,
  updated_at     timestamptz not null default now()
);

create trigger app_config_set_updated_at
  before update on public.app_config
  for each row execute function public.set_updated_at();

insert into public.app_config (key, value, client_visible, description) values
  ('recipe_validity_days',            '90',    false, 'Jours avant re-verification obligatoire d''une recette'),
  ('promote_min_clients',             '3',     false, 'Clients distincts en succes requis pour candidate -> shared'),
  ('deprecate_after_fails',           '3',     false, 'Echecs consecutifs avant declassement (recettes NON verrouillees)'),
  ('max_attempts_per_site',           '3',     false, 'Plafond de tentatives de la cascade par site avant arret + diagnostic'),
  ('max_feedback_per_account_per_day','200',   false, 'Plafond de remontees run_feedback par compte et par jour'),
  ('enforce_url_country',             'true',  false, 'Le pays deduit de l''URL impose le pays de sortie fournisseur; sinon alerte'),
  ('provider_order',
     '["local","firecrawl_normal","scrapfly_datacenter","brightdata","scrapfly_asp"]', false,
     'Cascade intelligente: ordre de repli par defaut (court-circuite par domains.best_provider). '
     'Firecrawl en 1er payant: quota gratuit 1000/mois, echecs a 0 credit; le profil de domaine '
     'route les sites Akamai connus directement vers brightdata (evite un echec Firecrawl inutile).'),
  ('credit_coeff',
     '{"firecrawl_normal":1,"firecrawl_stealth":5,"scrapfly_datacenter":0.18,"scrapfly_asp":5.4,"brightdata":2.7}', false,
     'RATIO de cout mesure vs page Firecrawl-normal (base = cout_page / 0.00083 $). Mesures reelles Etape 1: '
     'FC-normal 0.00083$, FC-stealth 0.00415$, Scrapfly-dc 0.00015$, Scrapfly-asp 0.0045$, BrightData ~0.00225$.'),
  ('credit_margin', '1.5', false,
     'Marge unique et explicite. Credits Eloshon debites = max(1, ceil(credit_coeff[key] * credit_margin)). '
     'Ex: firecrawl_normal=2, firecrawl_stealth=8, scrapfly_datacenter=1, scrapfly_asp=9, brightdata=5.');

-- =========================================================================
-- 2. domains — shared domain profile (Etape 3)
--    No 'promoted' flag: visibility derives from having a shared recipe (fix #1).
--    provider_stats + best_provider_measured_at let us re-evaluate (fix #5).
--    country distinct from locale (fix #6).
-- =========================================================================
create table public.domains (
  host                      text primary key,
  platform                  text,
  blocked_by                text,
  needs_browser             boolean not null default false,
  needs_unlock              boolean not null default false,
  best_provider             text,
  best_mode                 text,
  best_provider_measured_at timestamptz,
  provider_stats            jsonb not null default '{}'::jsonb,
    -- {"scrapfly":{"last_measured":"...","provider_units":1,"eloshon_credits":1,"success":true,"ms":3800}, ...}
  country                   text,   -- pays attendu, ex 'BE' (impose le pays de sortie fournisseur)
  locale                    text,   -- langue/locale, ex 'fr_BE' (distinct du pays)
  url_shape                 text,
  sitemaps                  text[] not null default '{}',
  success_rate              numeric,
  runs                      int not null default 0,
  first_seen                timestamptz not null default now(),
  last_verified             timestamptz not null default now(),
  constraint domains_blocked_by_chk check (blocked_by is null or blocked_by in ('none','cloudflare','akamai','datadome','other')),
  constraint domains_platform_chk   check (platform  is null or platform  in ('shopify','woocommerce','prestashop','generic'))
);

create index domains_platform_idx on public.domains (platform);

-- =========================================================================
-- 3. recipes — versioned recipes (Etape 3)
--    locked = reference recipes never auto-deprecated (fix #7).
--    country optional if a recipe is specific to a regional version (fix #6).
-- =========================================================================
create table public.recipes (
  id                 uuid primary key default gen_random_uuid(),
  host               text not null references public.domains(host) on delete cascade,
  version            int not null,
  product_selectors  jsonb,
  pagination         jsonb,        -- {"type":"offset|page|cursor","param":"...","step":N}
  internal_api       jsonb,        -- {"endpoint_tpl":"...","method":"GET","page_param":"...","json_path":"..."} (A1)
  extractor_strategy text,         -- jsonld|microdata|embedded-json|dom|shopify-json
  fields_available   text[] not null default '{}',
  status             text not null default 'candidate',  -- candidate|shared|deprecated
  locked             boolean not null default false,
  country            text,
  success_count      int not null default 0,
  fail_count         int not null default 0,
  consecutive_fails  int not null default 0,
  distinct_clients   int not null default 0,
  created_by         text not null default 'client',      -- 'eloshon' | 'client'
  created_at         timestamptz not null default now(),
  last_verified      timestamptz not null default now(),
  constraint recipes_status_chk     check (status in ('candidate','shared','deprecated')),
  constraint recipes_created_by_chk check (created_by in ('eloshon','client')),
  constraint recipes_version_uniq   unique (host, version)
);

create index recipes_host_status_idx on public.recipes (host, status);
create index recipes_shared_idx      on public.recipes (host) where status = 'shared';

-- =========================================================================
-- 4. run_feedback — anonymized run outcomes (Etape 3)
--    country_used / country_mismatch for the geolocation rule (fix #6).
--    client_hash+day index for the per-account daily feedback cap (fix #7).
-- =========================================================================
create table public.run_feedback (
  id               bigint generated always as identity primary key,
  host             text not null,
  recipe_id        uuid references public.recipes(id) on delete set null,
  outcome          text not null,          -- success|fail|partial
  products_found   int,
  duration_ms      int,
  provider_used    text,
  mode_used        text,
  eloshon_credits  int,
  country_used     text,
  country_mismatch boolean not null default false,
  client_hash      text,                    -- HMAC(license, pepper) — non reversible
  created_at       timestamptz not null default now(),
  constraint run_feedback_outcome_chk check (outcome in ('success','fail','partial'))
);

create index run_feedback_host_idx       on public.run_feedback (host, created_at desc);
create index run_feedback_recipe_idx     on public.run_feedback (recipe_id);
create index run_feedback_client_day_idx on public.run_feedback (client_hash, created_at desc);

-- =========================================================================
-- 5. accounts — licenses & quota (Etape 2, "ma cle" mode)
--    blocked / blocked_reason to block an abusive account (fix #7).
-- =========================================================================
create table public.accounts (
  id             uuid primary key default gen_random_uuid(),
  license_hash   text unique not null,
  plan           text not null default 'free',
  monthly_quota  int not null default 1000,       -- credits Eloshon / mois
  period_start   date not null default public.current_period(),
  blocked        boolean not null default false,
  blocked_reason text,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create index accounts_license_idx on public.accounts (license_hash);

-- =========================================================================
-- 6. account_usage — cumulative consumption per account & period (fix #3)
--    Avoids aggregating provider_calls on every quota check.
-- =========================================================================
create table public.account_usage (
  account_id           uuid not null references public.accounts(id) on delete cascade,
  period_start         date not null,
  eloshon_credits_used int not null default 0,
  provider_units_used  int not null default 0,
  requests             int not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (account_id, period_start)
);

create trigger account_usage_set_updated_at
  before update on public.account_usage
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 7. provider_calls — accounting (Etape 2, 3 providers)
--    Stores BOTH provider_units (raw) and eloshon_credits (normalized) (fix #2).
-- =========================================================================
create table public.provider_calls (
  id              bigint generated always as identity primary key,
  account_id      uuid references public.accounts(id) on delete cascade,
  host            text,
  provider        text not null,     -- firecrawl|scrapfly|brightdata
  mode            text,              -- normal|stealth|asp|datacenter
  provider_units  int not null default 0,  -- unites brutes du fournisseur (Scrapfly 1/30, BD 1, FC 1/5)
  eloshon_credits int not null default 0,  -- credits Eloshon decomptes (0 si echec)
  http_status     int,
  success         boolean not null default false,
  billing         text not null default 'eloshon',  -- 'eloshon' | 'client_key'
  created_at      timestamptz not null default now(),
  constraint provider_calls_provider_chk check (provider in ('firecrawl','scrapfly','brightdata')),
  constraint provider_calls_billing_chk  check (billing  in ('eloshon','client_key'))
);

create index provider_calls_account_period_idx on public.provider_calls (account_id, created_at);
create index provider_calls_host_idx           on public.provider_calls (host);

-- =========================================================================
-- Quota RPCs — called by the Edge Function (service_role).
-- check_quota: resets period on first call of a new month (fix #4), returns allowance.
-- record_provider_call: writes the call and increments the cumulative counter (fix #2/#3).
-- =========================================================================
create or replace function public.check_quota(p_license_hash text, p_estimate int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_account public.accounts;
  v_period  date := public.current_period();
  v_used    int;
begin
  -- Serialise les operations concurrentes du meme compte (minor #1).
  perform pg_advisory_xact_lock(hashtext(p_license_hash));
  select * into v_account from public.accounts where license_hash = p_license_hash;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_account');
  end if;
  if v_account.blocked or not v_account.active then
    return jsonb_build_object('allowed', false, 'reason', 'account_blocked');
  end if;
  -- Reset de periode au premier appel du nouveau mois.
  if v_account.period_start < v_period then
    update public.accounts set period_start = v_period where id = v_account.id;
  end if;
  insert into public.account_usage (account_id, period_start)
    values (v_account.id, v_period)
    on conflict (account_id, period_start) do nothing;
  select eloshon_credits_used into v_used
    from public.account_usage where account_id = v_account.id and period_start = v_period;
  return jsonb_build_object(
    'allowed',   (v_used + coalesce(p_estimate, 0)) <= v_account.monthly_quota,
    'used',      v_used,
    'quota',     v_account.monthly_quota,
    'remaining', v_account.monthly_quota - v_used,
    'period',    v_period
  );
end;
$$;

create or replace function public.record_provider_call(
  p_license_hash   text,
  p_host           text,
  p_provider       text,
  p_mode           text,
  p_provider_units int,
  p_eloshon_credits int,
  p_http_status    int,
  p_success        boolean,
  p_billing        text default 'eloshon'
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_account_id uuid;
  v_period     date := public.current_period();
begin
  -- Serialise les operations concurrentes du meme compte (minor #1).
  perform pg_advisory_xact_lock(hashtext(p_license_hash));
  select id into v_account_id from public.accounts where license_hash = p_license_hash;
  insert into public.provider_calls
    (account_id, host, provider, mode, provider_units, eloshon_credits, http_status, success, billing)
  values
    (v_account_id, p_host, p_provider, p_mode, p_provider_units, p_eloshon_credits, p_http_status, p_success, p_billing);
  -- Le compteur cumule n'augmente que sur succes facture a Eloshon.
  if p_success and p_billing = 'eloshon' and v_account_id is not null then
    insert into public.account_usage (account_id, period_start, eloshon_credits_used, provider_units_used, requests)
      values (v_account_id, v_period, p_eloshon_credits, p_provider_units, 1)
      on conflict (account_id, period_start) do update set
        eloshon_credits_used = public.account_usage.eloshon_credits_used + excluded.eloshon_credits_used,
        provider_units_used  = public.account_usage.provider_units_used  + excluded.provider_units_used,
        requests             = public.account_usage.requests + 1;
  end if;
end;
$$;

-- Les RPC ne doivent etre appelees que par le service_role (Edge Function).
revoke execute on function public.check_quota(text, int) from public, anon, authenticated;
revoke execute on function public.record_provider_call(text, text, text, text, int, int, int, boolean, text)
  from public, anon, authenticated;
-- BLOQUANT corrige: on redonne execute au service_role (Edge Function).
grant execute on function public.check_quota(text, int) to service_role;
grant execute on function public.record_provider_call(text, text, text, text, int, int, int, boolean, text)
  to service_role;

-- =========================================================================
-- RLS — read for authenticated (config visible + shared recipes only),
--        writes reserved to service_role (no policy = deny for anon/authenticated).
-- =========================================================================
alter table public.app_config     enable row level security;
alter table public.domains        enable row level security;
alter table public.recipes        enable row level security;
alter table public.run_feedback   enable row level security;
alter table public.accounts       enable row level security;
alter table public.account_usage  enable row level security;
alter table public.provider_calls enable row level security;

-- app_config: uniquement les cles marquees client_visible (minor #1).
create policy read_config_public on public.app_config
  for select to authenticated using (client_visible = true);

-- domains: visible si le host possede au moins une recette partagee (fix #1).
create policy read_domains_with_shared_recipe on public.domains
  for select to authenticated
  using (exists (select 1 from public.recipes r where r.host = domains.host and r.status = 'shared'));

-- recipes: uniquement les partagees.
create policy read_shared_recipes on public.recipes
  for select to authenticated using (status = 'shared');

-- run_feedback, accounts, account_usage, provider_calls : aucune policy => service_role only.

-- Defense en profondeur (ne pas dependre des default privileges) :
-- lecture explicite pour authenticated uniquement sur les 3 tables partagees,
-- et revocation totale sur les tables sensibles pour anon + authenticated.
grant select on public.app_config, public.domains, public.recipes to authenticated;
revoke all on public.run_feedback, public.accounts, public.account_usage, public.provider_calls
  from anon, authenticated;
