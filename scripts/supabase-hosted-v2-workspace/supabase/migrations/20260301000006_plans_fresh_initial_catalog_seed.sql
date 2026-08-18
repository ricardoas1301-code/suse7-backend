-- =============================================================================
-- DEV.V2 PLANS FRESH INITIAL CATALOG SEED — somente banco vazio (count=0)
-- Posição: imediatamente após plans_commercial_schema_bootstrap
--
-- Materializa baseline inicial Fresh DEV V2 (8 planos).
-- NÃO executa merge comercial em banco existente (partial ou divergente).
-- =============================================================================

DO $$
DECLARE
  v_existing_count integer;
BEGIN
  SELECT COUNT(*)::int INTO v_existing_count FROM public.plans;

  IF v_existing_count > 0 THEN
    RAISE NOTICE 'plans_fresh_seed: public.plans possui % row(s) — seed Fresh ignorado (preserva catálogo existente)', v_existing_count;
    RETURN;
  END IF;

  INSERT INTO public.plans (
    name, id, plan_key, display_name, marketing_name, slug,
    price, price_monthly, price_cents,
    sales_limit_monthly, sales_range_min, sales_range_max,
    limit_pricings, billing_required, is_active, pricing_mode, sort_order, tier, description
  ) VALUES
    (
      'Baby', 'a1000001-0001-4001-8001-000000000001'::uuid, 'baby', 'Baby', 'Baby', 'baby',
      59.00, 59.00, 5900, 50, 0, 50, 50, true, true, 'fixed', 10, 'baby',
      'Faixa 0–50 vendas/mês — Fresh DEV V2 baseline inicial'
    ),
    (
      'Start', 'a1000001-0001-4001-8001-000000000002'::uuid, 'start', 'Start', 'Start', 'start',
      99.00, 99.00, 9900, 200, 51, 200, 200, true, true, 'fixed', 20, 'start',
      'Faixa 51–200 vendas/mês'
    ),
    (
      'Crescer', 'a1000001-0001-4001-8001-000000000003'::uuid, 'crescer', 'Crescer', 'Crescer', 'crescer',
      155.00, 155.00, 15500, 500, 201, 500, 500, true, true, 'fixed', 30, 'crescer',
      'Faixa 201–500 vendas/mês'
    ),
    (
      'Pro', 'a1000001-0001-4001-8001-000000000004'::uuid, 'pro', 'Pro', 'Pro', 'pro',
      249.00, 249.00, 24900, 1000, 501, 1000, 1000, true, true, 'fixed', 40, 'pro',
      'Faixa 501–1.000 vendas/mês'
    ),
    (
      'Scale', 'a1000001-0001-4001-8001-000000000005'::uuid, 'scale', 'Scale', 'Scale', 'scale',
      399.00, 399.00, 39900, 3000, 1001, 3000, 3000, true, true, 'fixed', 50, 'scale',
      'Faixa 1.001–3.000 vendas/mês'
    ),
    (
      'Elite', 'a1000001-0001-4001-8001-000000000006'::uuid, 'elite', 'Elite', 'Elite', 'elite',
      649.00, 649.00, 64900, 10000, 3001, 10000, 10000, true, true, 'fixed', 60, 'elite',
      'Faixa 3.001–10.000 vendas/mês'
    ),
    (
      'Enterprise', 'a1000001-0001-4001-8001-000000000007'::uuid, 'enterprise', 'Enterprise', 'Enterprise', 'enterprise',
      1099.00, 1099.00, 109900, 20000, 10001, 20000, 20000, true, true, 'fixed', 70, 'enterprise',
      'Faixa 10.001–20.000 vendas/mês'
    ),
    (
      'Infinity', 'a1000001-0001-4001-8001-000000000008'::uuid, 'infinity', 'Infinity', 'Infinity', 'infinity',
      NULL, NULL, NULL, NULL, 20001, NULL, NULL, true, true, 'quote', 80, 'infinity',
      'Faixa 20.001+ — sob consulta'
    );

  -- Validação Fresh-only (baseline inicial autorizado)
  IF (SELECT COUNT(*)::int FROM public.plans) <> 8 THEN
    RAISE EXCEPTION 'plans_fresh_seed: esperado 8 planos após seed Fresh';
  END IF;

  IF (SELECT sales_limit_monthly FROM public.plans WHERE plan_key = 'baby' LIMIT 1) IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'plans_fresh_seed: baby sales_limit_monthly baseline inválido pós-seed';
  END IF;

  IF EXISTS (
    WITH ordered AS (
      SELECT plan_key, sales_range_min, sales_range_max, sort_order,
             LAG(sales_range_max) OVER (ORDER BY sort_order) AS prev_max
      FROM public.plans
      WHERE plan_key IN ('baby','start','crescer','pro','scale','elite','enterprise','infinity')
    )
    SELECT 1 FROM ordered
    WHERE prev_max IS NOT NULL AND sales_range_min IS DISTINCT FROM prev_max + 1
  ) THEN
    RAISE EXCEPTION 'plans_fresh_seed: gap/overlap nas faixas baseline Fresh';
  END IF;
END $$;
