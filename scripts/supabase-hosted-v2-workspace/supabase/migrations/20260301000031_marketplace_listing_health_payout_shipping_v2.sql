-- ======================================================================
-- marketplace_listing_health — payout oficial + frete v2 + subsídio ML
--
-- Resolve erro PostgREST: column "marketplace_payout_amount_brl" does not exist
-- e alinha o schema com mlHealthSchemaCompat + mlListingHealthPersist.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; não apaga dados; defaults implícitos NULL.
-- Rodar no SQL Editor do Supabase (ou via CLI migrations).
-- ======================================================================

-- ---------------------------------------------------------------------
-- 1) Frete v2 (shipping_cost legado permanece; amount espelha valor oficial)
-- ---------------------------------------------------------------------
ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS shipping_cost_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS shipping_cost_currency text,
  ADD COLUMN IF NOT EXISTS shipping_cost_source text,
  ADD COLUMN IF NOT EXISTS shipping_cost_context text,
  ADD COLUMN IF NOT EXISTS shipping_cost_label text;

COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_amount IS
  'Custo de envio (vendedor) em BRL — espelho oficial usado em net_proceeds.';
COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_currency IS 'Moeda do frete persistido (ex.: BRL).';
COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_source IS 'Origem do valor (listing_prices, sale_fee_details, item, health, etc.).';
COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_context IS 'free_for_buyer | buyer_pays';
COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_label IS 'Rótulo curto exibível (ex.: custo oficial ML).';

-- ---------------------------------------------------------------------
-- 2) Payout / repasse líquido (paridade com net_proceeds no backend)
-- ---------------------------------------------------------------------
ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_source text,
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_source text,
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_label text;

COMMENT ON COLUMN public.marketplace_listing_health.marketplace_payout_amount IS
  'Repasse líquido unitário (BRL) — mesmo valor que marketplace_payout_amount_brl quando BRL.';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_payout_amount_brl IS
  'Repasse líquido oficial persistido (BRL). Fonte de verdade para UI “Você recebe”.';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_payout_source IS
  'Proveniência do payout (ex.: official_components_sale_fee_shipping, ml_item_net_receivable_explicit).';

COMMENT ON COLUMN public.marketplace_listing_health.marketplace_cost_reduction_amount IS
  'Subsídio / redução de tarifa aplicada pelo marketplace (BRL).';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_cost_reduction_amount_brl IS
  'Espelho BRL de marketplace_cost_reduction_amount.';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_cost_reduction_source IS 'Origem da redução (listing_prices, coluna health, etc.).';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_cost_reduction_label IS 'Rótulo curto para exibição.';

-- ---------------------------------------------------------------------
-- 3) Preço list/promo (caso migration antiga não tenha rodado em algum ambiente)
-- ---------------------------------------------------------------------
ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS list_or_original_price_brl numeric(18, 6),
  ADD COLUMN IF NOT EXISTS promotional_price_brl numeric(18, 6);

-- ---------------------------------------------------------------------
-- 4) Backfill não destrutivo (só preenche NULL a partir de colunas legadas)
-- ---------------------------------------------------------------------
UPDATE public.marketplace_listing_health
SET shipping_cost_amount = round(shipping_cost::numeric, 2)
WHERE shipping_cost_amount IS NULL
  AND shipping_cost IS NOT NULL;

UPDATE public.marketplace_listing_health
SET shipping_cost_currency = 'BRL'
WHERE shipping_cost_currency IS NULL
  AND (shipping_cost_amount IS NOT NULL OR shipping_cost IS NOT NULL);

UPDATE public.marketplace_listing_health
SET marketplace_payout_amount_brl = round(net_receivable::numeric, 2)
WHERE net_receivable IS NOT NULL
  AND marketplace_payout_amount_brl IS NULL;

UPDATE public.marketplace_listing_health
SET marketplace_payout_amount = round(net_receivable::numeric, 2)
WHERE net_receivable IS NOT NULL
  AND marketplace_payout_amount IS NULL;

UPDATE public.marketplace_listing_health
SET marketplace_payout_source = coalesce(
  marketplace_payout_source,
  'legacy_net_receivable_backfill'
)
WHERE marketplace_payout_amount_brl IS NOT NULL
  AND (marketplace_payout_source IS NULL OR btrim(marketplace_payout_source) = '');

-- Espelhar promo list migration histórica (idempotente)
UPDATE public.marketplace_listing_health
SET promotional_price_brl = promotion_price
WHERE promotional_price_brl IS NULL
  AND promotion_price IS NOT NULL;

-- ======================================================================
-- marketplace_listing_snapshots — conferência (schema esperado pelo backend)
--
-- Colunas usadas em INSERT (listingSnapshots.js):
--   id, listing_id, product_id, marketplace, price, promotion_price,
--   sale_fee_amount, shipping_cost, net_receivable, visits, orders,
--   captured_at, created_at
--
-- Nenhuma alteração obrigatória: net_receivable no snapshot = repasse no momento
-- da captura (prioriza payout oficial no código após health migrado).
-- ======================================================================

-- ======================================================================
-- Colunas esperadas em public.marketplace_listing_health (visão consolidada)
--
-- Identidade / chave:
--   id, user_id, marketplace, external_listing_id
-- Métricas ML:
--   visits, orders_count, conversion_rate
-- Taxas / receita:
--   sale_fee_percent, sale_fee_amount
-- Frete:
--   shipping_cost (legado), shipping_cost_amount, shipping_cost_currency,
--   shipping_cost_source, shipping_cost_context, shipping_cost_label
-- Repasse / payout:
--   net_receivable (legado / compat), marketplace_payout_amount,
--   marketplace_payout_amount_brl, marketplace_payout_source
-- Subsídio tarifa:
--   marketplace_cost_reduction_amount, marketplace_cost_reduction_amount_brl,
--   marketplace_cost_reduction_source, marketplace_cost_reduction_label
-- Preço catálogo:
--   promotion_price, list_or_original_price_brl, promotional_price_brl
-- Qualidade / envio / raw:
--   listing_quality_*, experience_*, shipping_mode, shipping_logistic_type,
--   shipping_tags, marketplace_messages, raw_json
-- Produto (opcional):
--   has_product_link, has_complete_costs, product_health_status
-- Auditoria:
--   api_imported_at, api_last_seen_at, updated_at
-- ======================================================================
