-- ======================================================================
-- DEV ONLY — Reset limpo Mercado Livre para UM seller/conta
--
-- Objetivo: remover integração ML + dados vinculados para permitir OAuth
-- de novo SEM apagar seller_companies nem perfil do usuário.
--
-- Escopo (ajuste se sua coluna não existir — ver seção comentada em products):
--   app_user_id             = c8a62ec6-cfbe-4ad9-98ea-49fadebeda50
--   marketplace_account_id  = 058476b2-deba-49ae-b371-d4acc32af110
--   external_seller_id ML   = 2649629037
--   marketplace             = mercado_livre
--
-- USO:
--   1) Rode primeiro só os blocos de auditoria (SELECT) numa transação READ ONLY
--      ou copie os SELECTs e valide os counts.
--   2) Revise os resultados.
--   3) Rode o script completo (BEGIN … COMMIT).
--   4) Para abortar após BEGIN: ROLLBACK;
--
-- ATENÇÃO: irreversível após COMMIT. Faça backup ou export dos SELECTs antes.
-- ======================================================================

BEGIN;

-- -----------------------------------------------------------------------
-- Parâmetros (literals — Supabase SQL Editor não usa \set)
-- -----------------------------------------------------------------------
DO $$
DECLARE
  v_user uuid := 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid;
  v_acc uuid := '058476b2-deba-49ae-b371-d4acc32af110'::uuid;
  v_ext text := '2649629037';
  v_mp text := 'mercado_livre';
BEGIN
  RAISE NOTICE 'DEV reset ML: user=%, account=%, external_seller_id=%, marketplace=%',
    v_user, v_acc, v_ext, v_mp;
END $$;

-- ======================================================================
-- FASE A — Auditoria (counts antes do delete)
-- Rode estes SELECTs também fora da transação se preferir snapshot.
-- ======================================================================

SELECT 'marketplace_accounts' AS tbl, count(*)::bigint AS n
FROM public.marketplace_accounts
WHERE id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
        AND external_seller_id = '2649629037'
      );

SELECT 'marketplace_account_sync_jobs' AS tbl, count(*)::bigint AS n
FROM public.marketplace_account_sync_jobs
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

SELECT 'ml_webhook_events' AS tbl, count(*)::bigint AS n
FROM public.ml_webhook_events
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        marketplace = 'mercado_livre'
        AND (
          coalesce(marketplace_user_id::text, user_id::text) = '2649629037'
          OR user_id::text = '2649629037'
        )
      );

SELECT 'ml_tokens' AS tbl, count(*)::bigint AS n
FROM public.ml_tokens
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

SELECT 'sales_orders' AS tbl, count(*)::bigint AS n
FROM public.sales_orders
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

SELECT 'sales_order_items (via orders)' AS tbl, count(*)::bigint AS n
FROM public.sales_order_items soi
JOIN public.sales_orders so ON so.id = soi.sales_order_id
WHERE so.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        so.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND so.marketplace = 'mercado_livre'
      );

SELECT 'order_raw_snapshots (via orders)' AS tbl, count(*)::bigint AS n
FROM public.order_raw_snapshots s
JOIN public.sales_orders so ON so.id = s.sales_order_id
WHERE so.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        so.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND so.marketplace = 'mercado_livre'
      );

SELECT 'marketplace_customers' AS tbl, count(*)::bigint AS n
FROM public.marketplace_customers
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

SELECT 'marketplace_listings' AS tbl, count(*)::bigint AS n
FROM public.marketplace_listings
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

SELECT 'marketplace_listing_health' AS tbl, count(*)::bigint AS n
FROM public.marketplace_listing_health h
WHERE EXISTS (
  SELECT 1 FROM public.marketplace_listings ml
  WHERE ml.id = h.listing_id
    AND (
      ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
      OR (
        ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND ml.marketplace = 'mercado_livre'
      )
    )
);

SELECT 'marketplace_listing_pictures' AS tbl, count(*)::bigint AS n
FROM public.marketplace_listing_pictures p
WHERE EXISTS (
  SELECT 1 FROM public.marketplace_listings ml
  WHERE ml.id = p.listing_id
    AND (
      ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
      OR (
        ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND ml.marketplace = 'mercado_livre'
      )
    )
);

SELECT 'listing_sales_metrics (listings desta conta)' AS tbl, count(*)::bigint AS n
FROM public.listing_sales_metrics m
JOIN public.marketplace_listings ml
  ON m.external_listing_id IS NOT NULL
 AND ml.external_listing_id IS NOT NULL
 AND m.external_listing_id = ml.external_listing_id
WHERE m.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND m.marketplace = 'mercado_livre'
  AND (
    ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND ml.marketplace = 'mercado_livre'
    )
  );

SELECT 'oauth_states (user)' AS tbl, count(*)::bigint AS n
FROM public.oauth_states
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid;

-- -----------------------------------------------------------------------
-- ml_sales_sync_runs (se existir — schema pode variar no DEV)
-- -----------------------------------------------------------------------
SELECT 'ml_sales_sync_runs' AS tbl,
       CASE
         WHEN to_regclass('public.ml_sales_sync_runs') IS NULL THEN -1::bigint
         ELSE (SELECT count(*)::bigint FROM public.ml_sales_sync_runs)
       END AS n_note;

-- -----------------------------------------------------------------------
-- products importados ML (ajuste se seu schema não tiver as colunas)
-- -----------------------------------------------------------------------
SELECT 'products (source_marketplace / imported flags — se existirem)' AS tbl,
       count(*)::bigint AS n
FROM public.products p
WHERE p.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND (
    (to_jsonb(p) ? 'source_marketplace' AND p.source_marketplace = 'mercado_livre')
    OR (to_jsonb(p) ? 'is_imported_from_marketplace' AND p.is_imported_from_marketplace IS TRUE)
  );

-- ======================================================================
-- FASE B — Deletes (ordem: filhos → pais; jobs/eventos antes da conta)
-- ======================================================================

-- B1) Jobs de sync
DELETE FROM public.marketplace_account_sync_jobs
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

-- B2) Webhook queue (conta + linhas órfãs com mesmo seller ML)
DELETE FROM public.ml_webhook_events
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        marketplace = 'mercado_livre'
        AND (
          coalesce(marketplace_user_id::text, user_id::text) = '2649629037'
          OR user_id::text = '2649629037'
        )
      );

-- B3) ml_sales_sync_runs (opcional — deleta por colunas que existirem)
DO $$
BEGIN
  IF to_regclass('public.ml_sales_sync_runs') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ml_sales_sync_runs' AND column_name = 'marketplace_account_id'
  ) THEN
    DELETE FROM public.ml_sales_sync_runs
    WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ml_sales_sync_runs' AND column_name = 'user_id'
  ) THEN
    DELETE FROM public.ml_sales_sync_runs
    WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid;
  END IF;
END $$;

-- B4) Snapshots de pedido → itens → pedidos
DELETE FROM public.order_raw_snapshots s
USING public.sales_orders so
WHERE so.id = s.sales_order_id
  AND (
    so.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      so.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND so.marketplace = 'mercado_livre'
    )
  );

DELETE FROM public.sales_order_items soi
USING public.sales_orders so
WHERE so.id = soi.sales_order_id
  AND (
    so.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      so.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND so.marketplace = 'mercado_livre'
    )
  );

DELETE FROM public.sales_orders
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

-- B5) Métricas por anúncio (só linhas cujo external_listing_id pertence aos listings desta conta)
DELETE FROM public.listing_sales_metrics m
USING public.marketplace_listings ml
WHERE m.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND m.marketplace = 'mercado_livre'
  AND m.external_listing_id IS NOT NULL
  AND ml.external_listing_id IS NOT NULL
  AND m.external_listing_id = ml.external_listing_id
  AND (
    ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND ml.marketplace = 'mercado_livre'
    )
  );

-- B6) Clientes marketplace
DELETE FROM public.marketplace_customers
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

-- B7) Health + fotos + listings
DELETE FROM public.marketplace_listing_health h
USING public.marketplace_listings ml
WHERE ml.id = h.listing_id
  AND (
    ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND ml.marketplace = 'mercado_livre'
    )
  );

DELETE FROM public.marketplace_listing_pictures p
USING public.marketplace_listings ml
WHERE ml.id = p.listing_id
  AND (
    ml.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
    OR (
      ml.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND ml.marketplace = 'mercado_livre'
    )
  );

DELETE FROM public.marketplace_listings
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
      );

-- B8) Produtos importados do ML (somente se colunas existirem)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'source_marketplace'
  ) THEN
    DELETE FROM public.products p
    WHERE p.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND p.source_marketplace = 'mercado_livre';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_imported_from_marketplace'
  ) THEN
    DELETE FROM public.products p
    WHERE p.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND p.is_imported_from_marketplace IS TRUE
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'source_marketplace'
        )
        OR p.source_marketplace = 'mercado_livre'
        OR p.source_marketplace IS NULL
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'marketplace_account_id'
  ) THEN
    DELETE FROM public.products p
    WHERE p.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
      AND p.marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid;
  END IF;
END $$;

-- B9) Tokens ML (OAuth)
DELETE FROM public.ml_tokens
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

-- B10) OAuth states antigos deste usuário (DEV) — não apaga seller_companies
DELETE FROM public.oauth_states
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid;

-- B11) Conta marketplace (por último)
DELETE FROM public.marketplace_accounts
WHERE id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
        AND marketplace = 'mercado_livre'
        AND external_seller_id = '2649629037'
      );

-- ======================================================================
-- FASE C — Validação pós-reset (deve tudo ser 0 para o escopo)
-- ======================================================================

SELECT 'POST marketplace_accounts' AS chk, count(*)::bigint AS n
FROM public.marketplace_accounts
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

SELECT 'POST ml_tokens' AS chk, count(*)::bigint AS n
FROM public.ml_tokens
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

SELECT 'POST ml_webhook_events (acc ou seller)' AS chk, count(*)::bigint AS n
FROM public.ml_webhook_events
WHERE marketplace_account_id = '058476b2-deba-49ae-b371-d4acc32af110'::uuid
   OR (
        marketplace = 'mercado_livre'
        AND coalesce(marketplace_user_id::text, user_id::text) = '2649629037'
      );

SELECT 'POST sales_orders' AS chk, count(*)::bigint AS n
FROM public.sales_orders
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

SELECT 'POST sales_order_items' AS chk, count(*)::bigint AS n
FROM public.sales_order_items
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'::uuid
  AND marketplace = 'mercado_livre';

COMMIT;

-- Para dry-run: comente o COMMIT acima e termine com ROLLBACK;
-- ROLLBACK;
