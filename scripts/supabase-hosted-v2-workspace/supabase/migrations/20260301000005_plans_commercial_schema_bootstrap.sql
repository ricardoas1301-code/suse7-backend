-- =============================================================================
-- DEV.V2 PLANS COMMERCIAL SCHEMA BOOTSTRAP — forward-safe (existing + fresh)
-- Posição: após core_schema_bootstrap, ANTES fresh seed e billing 042
--
-- Escopo:
--   • colunas comerciais/identidade (ADD IF NOT EXISTS)
--   • backfill de IDENTIDADE apenas onde NULL (plan_key, id, slug, display_name)
--   • NÃO altera preço/faixa/limite/billing_required existentes
--   • catálogo inicial materializado em 20260301220002 (somente plans vazio)
-- =============================================================================

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS plan_key text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS price_monthly numeric(12, 2),
  ADD COLUMN IF NOT EXISTS price_cents integer,
  ADD COLUMN IF NOT EXISTS sales_limit_monthly integer,
  ADD COLUMN IF NOT EXISTS sales_range_min integer,
  ADD COLUMN IF NOT EXISTS sales_range_max integer,
  ADD COLUMN IF NOT EXISTS billing_required boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS pricing_mode text DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS sort_order integer,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS marketing_name text,
  ADD COLUMN IF NOT EXISTS slug text;

UPDATE public.plans SET billing_required = true WHERE billing_required IS NULL;
UPDATE public.plans SET is_active = true WHERE is_active IS NULL;
UPDATE public.plans SET pricing_mode = 'fixed' WHERE pricing_mode IS NULL OR btrim(pricing_mode) = '';

ALTER TABLE public.plans
  ALTER COLUMN billing_required SET DEFAULT true,
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN pricing_mode SET DEFAULT 'fixed';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'billing_required' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.plans ALTER COLUMN billing_required SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'is_active' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.plans ALTER COLUMN is_active SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'pricing_mode' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.plans ALTER COLUMN pricing_mode SET NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS plans_plan_key_unique_idx
  ON public.plans (plan_key)
  WHERE plan_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS plans_slug_unique_idx
  ON public.plans (slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN public.plans.plan_key IS 'Chave comercial estável (baby, start, …). SSOT runtime.';
COMMENT ON COLUMN public.plans.price_monthly IS 'Preço mensal canônico (numeric). Autoridade comercial.';
COMMENT ON COLUMN public.plans.price_cents IS 'Representação inteira reconciliável (ROUND(price_monthly*100)).';
COMMENT ON COLUMN public.plans.sales_limit_monthly IS 'Limite mensal de vendas/pedidos do plano comercial.';
COMMENT ON COLUMN public.plans.limit_pricings IS 'LEGACY_COMPAT — espelho opcional; preferir sales_limit_monthly.';

-- ---------------------------------------------------------------------------
-- Identity backfill ONLY where NULL — never commercial overwrite
-- ---------------------------------------------------------------------------
UPDATE public.plans p
SET plan_key = m.plan_key
FROM (VALUES
  ('baby', 'baby'),
  ('start', 'start'),
  ('crescer', 'crescer'),
  ('pro', 'pro'),
  ('scale', 'scale'),
  ('elite', 'elite'),
  ('enterprise', 'enterprise'),
  ('infinity', 'infinity')
) AS m(name_key, plan_key)
WHERE p.plan_key IS NULL
  AND lower(btrim(p.name)) = m.name_key;

UPDATE public.plans
SET id = gen_random_uuid()
WHERE id IS NULL;

UPDATE public.plans
SET
  display_name = COALESCE(display_name, NULLIF(btrim(name), '')),
  marketing_name = COALESCE(marketing_name, NULLIF(btrim(name), '')),
  slug = COALESCE(slug, plan_key)
WHERE display_name IS NULL OR marketing_name IS NULL OR slug IS NULL;

-- ---------------------------------------------------------------------------
-- Validação estrutural (sem impor baseline comercial Fresh)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_dup_plan_key integer;
  v_dup_id integer;
BEGIN
  IF to_regclass('public.plans') IS NULL THEN
    RAISE EXCEPTION 'plans_schema_bootstrap: public.plans ausente';
  END IF;

  SELECT COUNT(*) INTO v_dup_plan_key
  FROM (SELECT plan_key FROM public.plans WHERE plan_key IS NOT NULL GROUP BY plan_key HAVING COUNT(*) > 1) d;
  IF v_dup_plan_key > 0 THEN
    RAISE EXCEPTION 'plans_schema_bootstrap: plan_key duplicado';
  END IF;

  SELECT COUNT(*) INTO v_dup_id
  FROM (SELECT id FROM public.plans WHERE id IS NOT NULL GROUP BY id HAVING COUNT(*) > 1) d;
  IF v_dup_id > 0 THEN
    RAISE EXCEPTION 'plans_schema_bootstrap: plans.id duplicado';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.plans
    WHERE pricing_mode IS NOT NULL AND pricing_mode NOT IN ('fixed', 'quote')
  ) THEN
    RAISE EXCEPTION 'plans_schema_bootstrap: pricing_mode inválido';
  END IF;
END $$;
