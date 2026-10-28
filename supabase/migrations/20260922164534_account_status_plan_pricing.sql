-- get_account_status expose le PRIX et le VOLUME du palier réellement associé
-- au compte, pour que les apps puissent afficher l'équivalent € d'un nombre de
-- crédits sans jamais coder un taux en dur.
--
-- APPLIQUÉ en production (ilaakzwnfgzkinyygevv) le 2026-09-22,
-- version 20260922164534.
--
-- Source de vérité : public.pricing_tiers, déjà en place et déjà utilisée par
-- le système de crédits. Aucune seconde source n'est créée ; le site Eloshon a
-- sa propre table product_tiers, mais c'est pricing_tiers qui vit à côté de
-- accounts et qui facture — c'est donc elle qui fait foi ici.
--
-- Résolution : accounts.plan -> pricing_tiers (product, tier). Un compte dont
-- le plan n'existe pas au catalogue (ex. un compte de développement sur un
-- plan maison) reçoit des NULL, jamais une valeur inventée.

-- ── 1. échelle Scraper alignée sur ce qui est publié sur eloshon.com ────────
-- Le seed initial portait les anciens volumes (3000 / 15000 / 60000 / 250000)
-- et ignorait le palier Découverte. Le site annonce désormais 750 / 5000 /
-- 25000 / 100000 / 400000 aux mêmes prix : facturer sur une autre échelle que
-- la vitrine ferait diverger le €/page affiché de celui réellement pratiqué.
-- Prix inchangés ; seuls les volumes bougent.
ALTER TABLE public.pricing_tiers DROP CONSTRAINT IF EXISTS pricing_tiers_tier_chk;
ALTER TABLE public.pricing_tiers
  ADD CONSTRAINT pricing_tiers_tier_chk
  CHECK (tier IN ('free', 'discovery', 'starter', 'growth', 'pro', 'agency'));

INSERT INTO public.pricing_tiers (product, tier, credits, price_eur, display_order)
VALUES ('scraper', 'discovery', 750, 9.00, 1)
ON CONFLICT (product, tier) DO UPDATE
  SET credits = EXCLUDED.credits, price_eur = EXCLUDED.price_eur,
      display_order = EXCLUDED.display_order, updated_at = now();

UPDATE public.pricing_tiers SET credits = 5000,   display_order = 2, updated_at = now()
  WHERE product = 'scraper' AND tier = 'starter';
UPDATE public.pricing_tiers SET credits = 25000,  display_order = 3, updated_at = now()
  WHERE product = 'scraper' AND tier = 'growth';
UPDATE public.pricing_tiers SET credits = 100000, display_order = 4, updated_at = now()
  WHERE product = 'scraper' AND tier = 'pro';
UPDATE public.pricing_tiers SET credits = 400000, display_order = 5, updated_at = now()
  WHERE product = 'scraper' AND tier = 'agency';

-- ── 2. get_account_status : + plan_price_eur / plan_credits ────────────────
-- Additive : tous les champs existants sont conservés à l'identique, seuls
-- deux champs s'ajoutent. Les appelants actuels ne voient aucune différence.
CREATE OR REPLACE FUNCTION public.get_account_status(p_license_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_account      public.accounts;
  v_period_month text := to_char(now(), 'YYYY-MM');
  v_period_date  date := public.current_period();
  v_quota_used   int  := 0;
  v_quota_limit  int  := 500;
  v_credits_used int  := 0;
  v_plan_price   numeric := null;
  v_plan_credits int     := null;
begin
  select * into v_account from public.accounts where license_hash = p_license_hash;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_account');
  end if;
  if v_account.blocked or not v_account.active then
    return jsonb_build_object('ok', false, 'reason', 'account_blocked');
  end if;

  select coalesce(free_products_used, 0), coalesce(free_products_limit, 500)
    into v_quota_used, v_quota_limit
    from public.account_free_quota
    where account_id = v_account.id and period_month = v_period_month;

  select coalesce(eloshon_credits_used, 0) into v_credits_used
    from public.account_usage
    where account_id = v_account.id and period_start = v_period_date;

  -- Palier du compte. Un plan hors catalogue (ou le palier gratuit, qui n'a ni
  -- prix ni volume) laisse les deux champs à NULL : le client sait alors qu'il
  -- n'y a pas de taux à afficher, plutôt que d'en inventer un.
  select price_eur, credits into v_plan_price, v_plan_credits
    from public.pricing_tiers
    where product = 'scraper' and tier = v_account.plan and active;

  return jsonb_build_object(
    'ok',                   true,
    'plan',                 v_account.plan,
    'scraper_credits',      v_account.scraper_credits,
    'converter_credits',    v_account.converter_credits,
    'free_quota_used',      v_quota_used,
    'free_quota_limit',     v_quota_limit,
    'period_month',         v_period_month,
    'credits_used_period',  v_credits_used,
    'plan_price_eur',       v_plan_price,
    'plan_credits',         v_plan_credits
  );
end;
$function$;

-- ── 3. garde-fous — annulent tout en cas d'incohérence de schéma ───────────
DO $$
DECLARE
  bad_price int; bad_credits int; dupes int; orphans int; r record; prev numeric := null;
BEGIN
  SELECT count(*) INTO bad_price FROM public.pricing_tiers
   WHERE active AND tier <> 'free' AND product <> 'bundle'
     AND (price_eur IS NULL OR price_eur <= 0);
  IF bad_price > 0 THEN
    RAISE EXCEPTION '% palier(s) payant(s) sans prix valide — un taux ne serait pas calculable', bad_price;
  END IF;

  SELECT count(*) INTO bad_credits FROM public.pricing_tiers
   WHERE active AND tier <> 'free' AND product <> 'bundle'
     AND (credits IS NULL OR credits <= 0);
  IF bad_credits > 0 THEN
    RAISE EXCEPTION '% palier(s) payant(s) sans volume de crédits valide — division impossible', bad_credits;
  END IF;

  SELECT count(*) INTO dupes FROM (
    SELECT product, tier FROM public.pricing_tiers WHERE active
    GROUP BY product, tier HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION '% couple(s) (product, tier) en double — la résolution du palier serait ambiguë', dupes;
  END IF;

  FOR r IN
    SELECT tier, credits, price_eur, price_eur / credits AS rate
      FROM public.pricing_tiers
     WHERE product = 'scraper' AND active AND credits > 0 AND price_eur > 0
     ORDER BY credits
  LOOP
    IF prev IS NOT NULL AND r.rate >= prev THEN
      RAISE EXCEPTION 'échelle Scraper non décroissante : % à % €/crédit n''est pas sous le palier inférieur (%)', r.tier, r.rate, prev;
    END IF;
    prev := r.rate;
  END LOOP;

  -- Comptes dont le plan ne résout pas : signalé, PAS bloquant (donnée
  -- préexistante, pas une erreur de cette migration).
  SELECT count(*) INTO orphans FROM public.accounts a
   WHERE a.active AND NOT a.blocked
     AND NOT EXISTS (SELECT 1 FROM public.pricing_tiers p
                      WHERE p.product = 'scraper' AND p.tier = a.plan AND p.active);
  IF orphans > 0 THEN
    RAISE NOTICE 'ATTENTION : % compte(s) actif(s) ont un plan hors catalogue — ils recevront plan_price_eur/plan_credits NULL (comportement voulu, pas de taux inventé)', orphans;
  END IF;

  RAISE NOTICE 'get_account_status expose desormais plan_price_eur et plan_credits';
END $$;
