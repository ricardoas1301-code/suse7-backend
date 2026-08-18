


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."calcular_precificacao"("p_cost" numeric, "p_markup_percent" numeric, "p_min_margin" numeric) RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  suggested numeric;
BEGIN
  IF p_markup_percent IS NOT NULL THEN
    suggested := round((p_cost * (1 + p_markup_percent/100))::numeric, 2);
  ELSE
    suggested := round((p_cost * (1 + p_min_margin/100))::numeric, 2);
  END IF;
  RETURN suggested;
END;
$$;


ALTER FUNCTION "public"."calcular_precificacao"("p_cost" numeric, "p_markup_percent" numeric, "p_min_margin" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calcular_precificacao"("in_price" numeric, "in_commission_percent" numeric, "in_shipping" numeric, "in_tax_percent" numeric, "in_fixed_fee" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE
  commission_amount numeric := COALESCE(in_price * in_commission_percent / 100.0, 0);
  tax_amount numeric := COALESCE(in_price * in_tax_percent / 100.0, 0);
  total_fees numeric := commission_amount + COALESCE(in_fixed_fee,0) + COALESCE(in_shipping,0) + tax_amount;
  net_receive numeric := in_price - total_fees;
BEGIN
  RETURN jsonb_build_object(
    'price', in_price,
    'commission_amount', commission_amount,
    'fixed_fee', in_fixed_fee,
    'shipping', in_shipping,
    'tax_amount', tax_amount,
    'total_fees', total_fees,
    'net_receive', net_receive,
    'profit', net_receive
  );
END;
$$;


ALTER FUNCTION "public"."calcular_precificacao"("in_price" numeric, "in_commission_percent" numeric, "in_shipping" numeric, "in_tax_percent" numeric, "in_fixed_fee" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calcular_precificacao_automatica"("in_product_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE
  p public.products%ROWTYPE;
  r public.marketplace_rules%ROWTYPE;
  commission numeric;
  tax numeric;
  total_fees numeric;
  repasse numeric;
  lucro numeric;
BEGIN
  SELECT * INTO p FROM public.products WHERE id = in_product_id;

  SELECT * INTO r FROM public.marketplace_rules
  WHERE marketplace = p.marketplace
  ORDER BY updated_at DESC
  LIMIT 1;

  commission := p.price * COALESCE(r.commission_percent,0) / 100.0;
  tax := p.price * COALESCE(r.tax_percent,0) / 100.0;
  total_fees := commission + COALESCE(r.fixed_fee,0) + p.shipping + tax;
  repasse := p.price - total_fees;
  lucro := repasse - p.cost;

  RETURN jsonb_build_object(
    'product_id', p.id,
    'price', p.price,
    'repasse', repasse,
    'lucro', lucro,
    'frete', p.shipping,
    'comissoes', commission,
    'imposto', tax,
    'total_fees', total_fees
  );
END;
$$;


ALTER FUNCTION "public"."calcular_precificacao_automatica"("in_product_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_auth_uid"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT auth.uid();
$$;


ALTER FUNCTION "public"."current_auth_uid"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_old_logs"("days" integer DEFAULT 30) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE cnt int := 0;
BEGIN
  DELETE FROM public.logs
  WHERE created_at < now() - (days || ' days')::interval
  RETURNING 1 INTO cnt;

  RETURN COALESCE(cnt,0);
END;
$$;


ALTER FUNCTION "public"."delete_old_logs"("days" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."ml_tokens" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "expires_in" integer NOT NULL,
    "scope" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ml_user_id" "text" NOT NULL,
    "token_type" "text" NOT NULL,
    "ml_nickname" "text"
);


ALTER TABLE "public"."ml_tokens" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") RETURNS "public"."ml_tokens"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT *
  FROM public.ml_tokens
  WHERE user_id = in_user_id
  LIMIT 1;
$$;


ALTER FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  UPDATE public.profiles
  SET is_trial = true,
      trial_expiration = v_now + interval '14 days',
      plan = 'bronze'
  WHERE id = in_user_id;

  RETURN jsonb_build_object(
    'user_id', in_user_id,
    'trial_expires_at', v_now + interval '14 days'
  );
END;
$$;


ALTER FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_ad_title"("val" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF val IS NULL THEN
    RETURN NULL;
  END IF;

  -- trim + lower + colapsar múltiplos espaços
  RETURN regexp_replace(lower(trim(val)), '\s+', ' ', 'g');
END;
$$;


ALTER FUNCTION "public"."normalize_ad_title"("val" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  tok public.ml_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM public.ml_tokens WHERE user_id = in_user_id LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','no_token');
  END IF;

  UPDATE public.ml_tokens
  SET updated_at = now()
  WHERE id = tok.id;

  RETURN jsonb_build_object('status','marked');
END;
$$;


ALTER FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.logs(id, user_id, action, detail)
  VALUES (gen_random_uuid(), in_user_id, in_action, in_detail);
END;
$$;


ALTER FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_old numeric;
BEGIN
  SELECT price INTO v_old FROM public.products WHERE id = in_product_id;

  UPDATE public.products
  SET price = in_new_price, updated_at = now()
  WHERE id = in_product_id;

  INSERT INTO public.pricing_history(product_id, old_price, new_price, marketplace, status)
  VALUES (in_product_id, v_old, in_new_price, (SELECT marketplace FROM public.products WHERE id = in_product_id), 'updated');

  RETURN jsonb_build_object('product_id', in_product_id, 'old_price', v_old, 'new_price', in_new_price);
END;
$$;


ALTER FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_monthly_usage"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE cnt int := 0;
BEGIN
  UPDATE public.user_usage
  SET pricings_used = 0,
      renewal_date = date_trunc('month', now()) + interval '1 month'
  WHERE true
  RETURNING 1 INTO cnt;

  RETURN COALESCE(cnt,0);
END;
$$;


ALTER FUNCTION "public"."reset_monthly_usage"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_title_normalized_product_ad_titles"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.title_normalized = public.normalize_ad_title(NEW.title);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_title_normalized_product_ad_titles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at_product_ad_titles"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at_product_ad_titles"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_product_image_links_sort_order"("p_payload" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF p_payload IS NULL OR jsonb_array_length(p_payload) = 0 THEN
    RETURN;
  END IF;

  UPDATE public.product_image_links pil
  SET sort_order = v.sort_order
  FROM (
    SELECT (elem->>'id')::uuid AS id, COALESCE((elem->>'sort_order')::int, 0) AS sort_order
    FROM jsonb_array_elements(p_payload) AS elem
  ) v
  WHERE pil.id = v.id AND pil.user_id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."update_product_image_links_sort_order"("p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_product_variants_sort_order"("p_product_id" "uuid", "p_payload" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF p_product_id IS NULL OR p_payload IS NULL OR jsonb_array_length(p_payload) = 0 THEN
    RETURN;
  END IF;

  UPDATE public.product_variants pv
  SET sort_order = v.sort_order
  FROM (
    SELECT (elem->>'id')::uuid AS id, COALESCE((elem->>'sort_order')::int, 0) AS sort_order
    FROM jsonb_array_elements(p_payload) AS elem
  ) v
  WHERE pv.id = v.id
    AND pv.product_id = p_product_id
    AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_product_id AND p.user_id = auth.uid());
END;
$$;


ALTER FUNCTION "public"."update_product_variants_sort_order"("p_product_id" "uuid", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verificar_limite_plano"("in_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE
  v_plan text;
  v_limit integer;
  v_usage integer;
  v_month text := to_char(now(), 'YYYY-MM');
BEGIN
  SELECT plan INTO v_plan FROM public.profiles WHERE id = in_user_id;
  SELECT limit_pricings INTO v_limit FROM public.plans WHERE name = v_plan;
  SELECT pricings_used INTO v_usage FROM public.user_usage WHERE user_id = in_user_id AND month = v_month;

  RETURN jsonb_build_object(
    'plan', v_plan,
    'limit', COALESCE(v_limit,0),
    'used', COALESCE(v_usage,0),
    'remaining', GREATEST(COALESCE(v_limit,0) - COALESCE(v_usage,0), 0)
  );
END;
$$;


ALTER FUNCTION "public"."verificar_limite_plano"("in_user_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "channel" "text",
    "movement_type" "text" NOT NULL,
    "qty_delta" integer NOT NULL,
    "reference_order_id" "uuid",
    "reference_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "chk_inventory_movements_movement_type_enum" CHECK (("movement_type" = ANY (ARRAY['sale'::"text", 'cancel'::"text", 'refund'::"text", 'adjustment'::"text"]))),
    CONSTRAINT "chk_inventory_movements_qty_delta_nonzero" CHECK (("qty_delta" <> 0))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "action" "text",
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketplace_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "marketplace" "text" NOT NULL,
    "commission_percent" numeric(6,4) DEFAULT 0,
    "fixed_fee" numeric(14,4) DEFAULT 0,
    "shipping_table" "jsonb" DEFAULT '{}'::"jsonb",
    "tax_percent" numeric(6,4) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."marketplace_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text",
    "link_url" "text",
    "scope" "text" DEFAULT 'global'::"text" NOT NULL,
    "entity_id" "uuid",
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ck_notifications_severity" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warn'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_states" (
    "state" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "marketplace" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."oauth_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plans" (
    "name" "text" NOT NULL,
    "limit_pricings" integer DEFAULT 0,
    "price" numeric(12,2) DEFAULT 0,
    "tier" "text"
);


ALTER TABLE "public"."plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pricing_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "old_price" numeric(14,4),
    "new_price" numeric(14,4),
    "date" timestamp with time zone DEFAULT "now"(),
    "marketplace" "text",
    "status" "text"
);


ALTER TABLE "public"."pricing_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_ad_titles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "title_normalized" "text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."product_ad_titles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_image_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "product_id" "uuid",
    "draft_key" "text",
    "variant_key" "text",
    "storage_path" "text" NOT NULL,
    "file_name" "text",
    "mime_type" "text",
    "size_bytes" bigint,
    "width" integer,
    "height" integer,
    "is_primary" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_product_image_links_product_or_draft" CHECK (((("product_id" IS NOT NULL) AND ("draft_key" IS NULL)) OR (("product_id" IS NULL) AND ("draft_key" IS NOT NULL))))
);


ALTER TABLE "public"."product_image_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "sku" "text" NOT NULL,
    "gtin" "text",
    "attributes" "jsonb" NOT NULL,
    "price" numeric(12,2),
    "stock_quantity" integer DEFAULT 0,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "uuid" NOT NULL,
    "stock_minimum" integer DEFAULT 0,
    "use_virtual_stock" boolean DEFAULT false,
    "virtual_stock_quantity" integer DEFAULT 0,
    "cost_price" numeric(14,2),
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "product_variants_stock_minimum_non_negative" CHECK (("stock_minimum" >= 0)),
    CONSTRAINT "product_variants_stock_non_negative" CHECK (("stock_quantity" >= 0)),
    CONSTRAINT "product_variants_virtual_stock_non_negative" CHECK (("virtual_stock_quantity" >= 0))
);


ALTER TABLE "public"."product_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "product_name" "text",
    "sku" "text" NOT NULL,
    "cost_price" numeric(14,4) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "description" "text",
    "brand" "text",
    "model" "text",
    "gtin" "text",
    "category_ml_id" "text",
    "fixed_costs" numeric(12,2) DEFAULT 0,
    "stock_quantity" integer DEFAULT 0,
    "stock_source" "text" DEFAULT 'manual'::"text",
    "lead_time_days" integer,
    "weight" numeric(10,3),
    "height" numeric(10,2),
    "width" numeric(10,2),
    "length" numeric(10,2),
    "assembled_height" numeric(10,2),
    "assembled_width" numeric(10,2),
    "assembled_length" numeric(10,2),
    "assembled_weight" numeric(10,3),
    "origin" "text",
    "supplier_name" "text",
    "notes" "text",
    "active" boolean DEFAULT true,
    "product_images" "text"[],
    "imported_from_channel" "text" DEFAULT 'manual'::"text",
    "parent_sku" "text",
    "ncm" "text",
    "seo_keywords" "text",
    "format" "text" DEFAULT 'simple'::"text" NOT NULL,
    "packaging_cost" numeric(12,2) DEFAULT 0,
    "operational_cost" numeric(12,2) DEFAULT 0,
    "stock_minimum" integer DEFAULT 0,
    "use_virtual_stock" boolean DEFAULT false,
    "virtual_stock_quantity" integer DEFAULT 0,
    "ad_titles" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


COMMENT ON COLUMN "public"."products"."ad_titles" IS 'Lista de títulos do anúncio (até 10). Ex: [{"id":"uuid","value":"Título do anúncio"}]';



COMMENT ON COLUMN "public"."products"."status" IS 'Status do produto: draft | ready | published';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text",
    "email" "text",
    "photo_url" "text",
    "plan" "text" DEFAULT 'bronze'::"text",
    "plan_expiration" timestamp with time zone,
    "is_trial" boolean DEFAULT false,
    "trial_expiration" timestamp with time zone,
    "ml_connected" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "asaas_customer_id" "text",
    "nome" "text",
    "whatsapp" "text",
    "telefone" "text",
    "nome_loja" "text",
    "cpf_cnpj" "text",
    "cep" "text",
    "endereco" "text",
    "numero" "text",
    "complemento" "text",
    "bairro" "text",
    "cidade" "text",
    "estado" "text",
    "imposto_percentual" numeric(10,2),
    "primeiro_login" boolean DEFAULT true NOT NULL,
    "last_login" timestamp with time zone DEFAULT "now"() NOT NULL,
    "site" "text",
    CONSTRAINT "profiles_plan_check" CHECK (("plan" = ANY (ARRAY['bronze'::"text", 'prata'::"text", 'ouro'::"text", 'diamante'::"text", 'top'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "sku_snapshot" "text" NOT NULL,
    "title_snapshot" "text",
    "external_item_id" "text",
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,2) NOT NULL,
    "total_price" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "chk_sales_order_items_quantity_positive" CHECK (("quantity" > 0)),
    CONSTRAINT "chk_sales_order_items_total_price_nonnegative" CHECK (("total_price" >= (0)::numeric)),
    CONSTRAINT "chk_sales_order_items_unit_price_nonnegative" CHECK (("unit_price" >= (0)::numeric))
);


ALTER TABLE "public"."sales_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "external_order_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "sold_at" timestamp with time zone NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'BRL'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "chk_sales_orders_channel_not_empty" CHECK ((TRIM(BOTH FROM "channel") <> ''::"text")),
    CONSTRAINT "chk_sales_orders_external_order_id_not_empty" CHECK ((TRIM(BOTH FROM "external_order_id") <> ''::"text")),
    CONSTRAINT "chk_sales_orders_status_not_empty" CHECK ((TRIM(BOTH FROM "status") <> ''::"text")),
    CONSTRAINT "chk_sales_orders_total_amount_nonnegative" CHECK (("total_amount" >= (0)::numeric))
);


ALTER TABLE "public"."sales_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "month" "text" NOT NULL,
    "pricings_used" integer DEFAULT 0,
    "renewal_date" timestamp with time zone
);


ALTER TABLE "public"."user_usage" OWNER TO "postgres";


ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."logs"
    ADD CONSTRAINT "logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketplace_rules"
    ADD CONSTRAINT "marketplace_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ml_tokens"
    ADD CONSTRAINT "ml_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ml_tokens"
    ADD CONSTRAINT "ml_tokens_user_id_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("name");



ALTER TABLE ONLY "public"."pricing_history"
    ADD CONSTRAINT "pricing_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_ad_titles"
    ADD CONSTRAINT "product_ad_titles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_image_links"
    ADD CONSTRAINT "product_image_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_user_sku_key" UNIQUE ("user_id", "sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_ad_titles"
    ADD CONSTRAINT "uq_product_ad_titles_user_product_normalized" UNIQUE ("user_id", "product_id", "title_normalized");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "uq_user_preferences_user_key" UNIQUE ("user_id", "key");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_usage"
    ADD CONSTRAINT "user_usage_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_inventory_movements_created_at" ON "public"."inventory_movements" USING "btree" ("created_at");



CREATE INDEX "idx_inventory_movements_movement_type" ON "public"."inventory_movements" USING "btree" ("movement_type");



CREATE INDEX "idx_inventory_movements_product_id" ON "public"."inventory_movements" USING "btree" ("product_id");



CREATE INDEX "idx_logs_created_at" ON "public"."logs" USING "btree" ("created_at");



CREATE INDEX "idx_logs_user" ON "public"."logs" USING "btree" ("user_id");



CREATE INDEX "idx_marketplace_rules_marketplace" ON "public"."marketplace_rules" USING "btree" ("marketplace");



CREATE INDEX "idx_ml_tokens_user" ON "public"."ml_tokens" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_ml_tokens_user_id_unique" ON "public"."ml_tokens" USING "btree" ("user_id");



CREATE INDEX "idx_notifications_user_active_created" ON "public"."notifications" USING "btree" ("user_id", "is_active", "created_at" DESC);



CREATE INDEX "idx_notifications_user_readat" ON "public"."notifications" USING "btree" ("user_id", "read_at");



CREATE INDEX "idx_notifications_user_scope_entity" ON "public"."notifications" USING "btree" ("user_id", "scope", "entity_id");



CREATE INDEX "idx_notifications_user_type_created" ON "public"."notifications" USING "btree" ("user_id", "type", "created_at" DESC);



CREATE INDEX "idx_pricing_history_date" ON "public"."pricing_history" USING "btree" ("date");



CREATE INDEX "idx_pricing_history_product" ON "public"."pricing_history" USING "btree" ("product_id");



CREATE INDEX "idx_product_image_links_draft_variant_sort" ON "public"."product_image_links" USING "btree" ("draft_key", "variant_key", "sort_order") WHERE ("draft_key" IS NOT NULL);



CREATE INDEX "idx_product_image_links_product_variant_sort" ON "public"."product_image_links" USING "btree" ("product_id", "variant_key", "sort_order") WHERE ("product_id" IS NOT NULL);



CREATE INDEX "idx_product_image_links_user_id" ON "public"."product_image_links" USING "btree" ("user_id");



CREATE INDEX "idx_product_variants_product_id" ON "public"."product_variants" USING "btree" ("product_id");



CREATE INDEX "idx_product_variants_product_sort" ON "public"."product_variants" USING "btree" ("product_id", "sort_order");



CREATE INDEX "idx_product_variants_sku" ON "public"."product_variants" USING "btree" ("sku");



CREATE INDEX "idx_product_variants_user_id" ON "public"."product_variants" USING "btree" ("user_id");



CREATE INDEX "idx_product_variants_user_product" ON "public"."product_variants" USING "btree" ("user_id", "product_id");



CREATE INDEX "idx_products_active" ON "public"."products" USING "btree" ("active");



CREATE INDEX "idx_products_gtin" ON "public"."products" USING "btree" ("gtin");



CREATE INDEX "idx_products_sku" ON "public"."products" USING "btree" ("sku");



CREATE INDEX "idx_products_user_id" ON "public"."products" USING "btree" ("user_id");



CREATE INDEX "idx_profiles_asaas_customer_id" ON "public"."profiles" USING "btree" ("asaas_customer_id");



CREATE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_plan" ON "public"."profiles" USING "btree" ("plan");



CREATE INDEX "idx_sales_order_items_order_id" ON "public"."sales_order_items" USING "btree" ("order_id");



CREATE INDEX "idx_sales_order_items_product_id" ON "public"."sales_order_items" USING "btree" ("product_id");



CREATE INDEX "idx_user_preferences_user" ON "public"."user_preferences" USING "btree" ("user_id");



CREATE INDEX "idx_user_preferences_user_key" ON "public"."user_preferences" USING "btree" ("user_id", "key");



CREATE INDEX "idx_user_usage_user" ON "public"."user_usage" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_user_usage_user_month" ON "public"."user_usage" USING "btree" ("user_id", "month");



CREATE UNIQUE INDEX "idx_variants_sku_unique" ON "public"."product_variants" USING "btree" ("sku");



CREATE INDEX "oauth_states_expires_at_idx" ON "public"."oauth_states" USING "btree" ("expires_at");



CREATE INDEX "oauth_states_user_id_idx" ON "public"."oauth_states" USING "btree" ("user_id");



CREATE UNIQUE INDEX "products_user_sku_unique" ON "public"."products" USING "btree" ("user_id", "sku");



CREATE UNIQUE INDEX "uq_product_image_links_primary_draft" ON "public"."product_image_links" USING "btree" ("draft_key", COALESCE("variant_key", '__global__'::"text")) WHERE (("is_primary" = true) AND ("draft_key" IS NOT NULL));



CREATE UNIQUE INDEX "uq_product_image_links_primary_product" ON "public"."product_image_links" USING "btree" ("product_id", COALESCE("variant_key", '__global__'::"text")) WHERE (("is_primary" = true) AND ("product_id" IS NOT NULL));



CREATE UNIQUE INDEX "uq_product_variants_user_sku" ON "public"."product_variants" USING "btree" ("user_id", "sku");



CREATE UNIQUE INDEX "ux_sales_orders_user_channel_external" ON "public"."sales_orders" USING "btree" ("user_id", "channel", "external_order_id");



CREATE OR REPLACE TRIGGER "product_image_links_updated_at" BEFORE UPDATE ON "public"."product_image_links" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "products_set_timestamp" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_timestamp"();



CREATE OR REPLACE TRIGGER "products_set_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "tr_product_ad_titles_title_normalized" BEFORE INSERT OR UPDATE ON "public"."product_ad_titles" FOR EACH ROW EXECUTE FUNCTION "public"."set_title_normalized_product_ad_titles"();



CREATE OR REPLACE TRIGGER "tr_product_ad_titles_updated_at" BEFORE UPDATE ON "public"."product_ad_titles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_product_ad_titles"();



CREATE OR REPLACE TRIGGER "trg_marketplace_rules_set_updated_at" BEFORE UPDATE ON "public"."marketplace_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_notifications_set_updated_at" BEFORE UPDATE ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_product_variants_updated" BEFORE UPDATE ON "public"."product_variants" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_products_set_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at_ml_tokens" BEFORE UPDATE ON "public"."ml_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_user_preferences_set_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "fk_inventory_movements_product" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "fk_inventory_movements_reference_order" FOREIGN KEY ("reference_order_id") REFERENCES "public"."sales_orders"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "fk_inventory_movements_user_profiles" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."product_ad_titles"
    ADD CONSTRAINT "fk_product_ad_titles_product" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "fk_sales_order_items_order" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_order_items"
    ADD CONSTRAINT "fk_sales_order_items_product" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."sales_orders"
    ADD CONSTRAINT "fk_sales_orders_user_profiles" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."logs"
    ADD CONSTRAINT "logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ml_tokens"
    ADD CONSTRAINT "ml_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pricing_history"
    ADD CONSTRAINT "pricing_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_image_links"
    ADD CONSTRAINT "product_image_links_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_usage"
    ADD CONSTRAINT "user_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



CREATE POLICY "delete_own_titles" ON "public"."product_ad_titles" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "insert_own_titles" ON "public"."product_ad_titles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_delete_policy" ON "public"."inventory_movements" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "inventory_movements_insert_policy" ON "public"."inventory_movements" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "inventory_movements_select_policy" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "inventory_movements_update_policy" ON "public"."inventory_movements" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "logs_owner_insert" ON "public"."logs" FOR INSERT WITH CHECK ((("user_id" = "public"."current_auth_uid"()) OR ("user_id" IS NULL)));



CREATE POLICY "logs_owner_select" ON "public"."logs" FOR SELECT USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "logs_service_role" ON "public"."logs" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."marketplace_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "marketplace_rules_select" ON "public"."marketplace_rules" FOR SELECT USING (true);



CREATE POLICY "marketplace_rules_service_role" ON "public"."marketplace_rules" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."ml_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ml_tokens_delete_own" ON "public"."ml_tokens" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "ml_tokens_insert_own" ON "public"."ml_tokens" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "ml_tokens_owner_delete" ON "public"."ml_tokens" FOR DELETE USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "ml_tokens_owner_insert" ON "public"."ml_tokens" FOR INSERT WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "ml_tokens_owner_select" ON "public"."ml_tokens" FOR SELECT USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "ml_tokens_owner_update" ON "public"."ml_tokens" FOR UPDATE USING (("user_id" = "public"."current_auth_uid"())) WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "ml_tokens_select_own" ON "public"."ml_tokens" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "ml_tokens_service_role" ON "public"."ml_tokens" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



CREATE POLICY "ml_tokens_update_own" ON "public"."ml_tokens" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_delete_own" ON "public"."notifications" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "notifications_insert_own" ON "public"."notifications" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "notifications_select_own" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "notifications_update_own" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plans_public_select" ON "public"."plans" FOR SELECT USING (true);



CREATE POLICY "plans_service_role" ON "public"."plans" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."pricing_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pricing_history_owner_select" ON "public"."pricing_history" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."products" "p"
  WHERE (("p"."id" = "pricing_history"."product_id") AND ("p"."user_id" = "public"."current_auth_uid"())))));



CREATE POLICY "pricing_history_service_role" ON "public"."pricing_history" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."product_ad_titles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_image_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_image_links_delete_own" ON "public"."product_image_links" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "product_image_links_insert_own" ON "public"."product_image_links" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "product_image_links_select_own" ON "public"."product_image_links" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "product_image_links_update_own" ON "public"."product_image_links" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."product_variants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_variants_owner_delete" ON "public"."product_variants" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "product_variants_owner_insert" ON "public"."product_variants" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "product_variants_owner_select" ON "public"."product_variants" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "product_variants_owner_update" ON "public"."product_variants" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products_owner_delete" ON "public"."products" FOR DELETE USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "products_owner_insert" ON "public"."products" FOR INSERT WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "products_owner_select" ON "public"."products" FOR SELECT USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "products_owner_update" ON "public"."products" FOR UPDATE USING (("user_id" = "public"."current_auth_uid"())) WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "products_service_role" ON "public"."products" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_owner_insert" ON "public"."profiles" FOR INSERT WITH CHECK (("id" = "public"."current_auth_uid"()));



CREATE POLICY "profiles_owner_select" ON "public"."profiles" FOR SELECT USING (("id" = "public"."current_auth_uid"()));



CREATE POLICY "profiles_owner_update" ON "public"."profiles" FOR UPDATE USING (("id" = "public"."current_auth_uid"())) WITH CHECK (("id" = "public"."current_auth_uid"()));



CREATE POLICY "profiles_service_role" ON "public"."profiles" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



ALTER TABLE "public"."sales_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_order_items_delete_policy" ON "public"."sales_order_items" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."sales_orders" "so"
  WHERE (("so"."id" = "sales_order_items"."order_id") AND ("so"."user_id" = "auth"."uid"())))));



CREATE POLICY "sales_order_items_insert_policy" ON "public"."sales_order_items" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."sales_orders" "so"
  WHERE (("so"."id" = "sales_order_items"."order_id") AND ("so"."user_id" = "auth"."uid"())))));



CREATE POLICY "sales_order_items_select_policy" ON "public"."sales_order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."sales_orders" "so"
  WHERE (("so"."id" = "sales_order_items"."order_id") AND ("so"."user_id" = "auth"."uid"())))));



CREATE POLICY "sales_order_items_update_policy" ON "public"."sales_order_items" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."sales_orders" "so"
  WHERE (("so"."id" = "sales_order_items"."order_id") AND ("so"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."sales_orders" "so"
  WHERE (("so"."id" = "sales_order_items"."order_id") AND ("so"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."sales_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_orders_delete_policy" ON "public"."sales_orders" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "sales_orders_insert_policy" ON "public"."sales_orders" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "sales_orders_select_policy" ON "public"."sales_orders" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "sales_orders_update_policy" ON "public"."sales_orders" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "select_own_titles" ON "public"."product_ad_titles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "update_own_titles" ON "public"."product_ad_titles" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_preferences_delete_own" ON "public"."user_preferences" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_preferences_insert_own" ON "public"."user_preferences" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "user_preferences_select_own" ON "public"."user_preferences" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_preferences_update_own" ON "public"."user_preferences" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."user_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_usage_owner_insert" ON "public"."user_usage" FOR INSERT WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "user_usage_owner_select" ON "public"."user_usage" FOR SELECT USING (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "user_usage_owner_update" ON "public"."user_usage" FOR UPDATE USING (("user_id" = "public"."current_auth_uid"())) WITH CHECK (("user_id" = "public"."current_auth_uid"()));



CREATE POLICY "user_usage_service_role" ON "public"."user_usage" USING ((("auth"."jwt"() ->> 'role'::"text") = 'service_role'::"text"));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."calcular_precificacao"("p_cost" numeric, "p_markup_percent" numeric, "p_min_margin" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."calcular_precificacao"("p_cost" numeric, "p_markup_percent" numeric, "p_min_margin" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calcular_precificacao"("p_cost" numeric, "p_markup_percent" numeric, "p_min_margin" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."calcular_precificacao"("in_price" numeric, "in_commission_percent" numeric, "in_shipping" numeric, "in_tax_percent" numeric, "in_fixed_fee" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."calcular_precificacao"("in_price" numeric, "in_commission_percent" numeric, "in_shipping" numeric, "in_tax_percent" numeric, "in_fixed_fee" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calcular_precificacao"("in_price" numeric, "in_commission_percent" numeric, "in_shipping" numeric, "in_tax_percent" numeric, "in_fixed_fee" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."calcular_precificacao_automatica"("in_product_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."calcular_precificacao_automatica"("in_product_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."calcular_precificacao_automatica"("in_product_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_auth_uid"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_auth_uid"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_auth_uid"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_auth_uid"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_old_logs"("days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_old_logs"("days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."delete_old_logs"("days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_old_logs"("days" integer) TO "service_role";



GRANT ALL ON TABLE "public"."ml_tokens" TO "anon";
GRANT ALL ON TABLE "public"."ml_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."ml_tokens" TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ml_token_for_user"("in_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."iniciar_teste_gratis"("in_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_ad_title"("val" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_ad_title"("val" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_ad_title"("val" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_ml_tokens_for_user"("in_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_log"("in_user_id" "uuid", "in_action" "text", "in_detail" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."registrar_precificacao"("in_product_id" "uuid", "in_new_price" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reset_monthly_usage"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_monthly_usage"() TO "anon";
GRANT ALL ON FUNCTION "public"."reset_monthly_usage"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_monthly_usage"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_title_normalized_product_ad_titles"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_title_normalized_product_ad_titles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_title_normalized_product_ad_titles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at_product_ad_titles"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at_product_ad_titles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at_product_ad_titles"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_product_image_links_sort_order"("p_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."update_product_image_links_sort_order"("p_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_product_image_links_sort_order"("p_payload" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_product_variants_sort_order"("p_product_id" "uuid", "p_payload" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."update_product_variants_sort_order"("p_product_id" "uuid", "p_payload" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_product_variants_sort_order"("p_product_id" "uuid", "p_payload" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."verificar_limite_plano"("in_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."verificar_limite_plano"("in_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."verificar_limite_plano"("in_user_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."logs" TO "anon";
GRANT ALL ON TABLE "public"."logs" TO "authenticated";
GRANT ALL ON TABLE "public"."logs" TO "service_role";



GRANT ALL ON TABLE "public"."marketplace_rules" TO "anon";
GRANT ALL ON TABLE "public"."marketplace_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."marketplace_rules" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."pricing_history" TO "anon";
GRANT ALL ON TABLE "public"."pricing_history" TO "authenticated";
GRANT ALL ON TABLE "public"."pricing_history" TO "service_role";



GRANT ALL ON TABLE "public"."product_ad_titles" TO "anon";
GRANT ALL ON TABLE "public"."product_ad_titles" TO "authenticated";
GRANT ALL ON TABLE "public"."product_ad_titles" TO "service_role";



GRANT ALL ON TABLE "public"."product_image_links" TO "anon";
GRANT ALL ON TABLE "public"."product_image_links" TO "authenticated";
GRANT ALL ON TABLE "public"."product_image_links" TO "service_role";



GRANT ALL ON TABLE "public"."product_variants" TO "anon";
GRANT ALL ON TABLE "public"."product_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."product_variants" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."sales_order_items" TO "anon";
GRANT ALL ON TABLE "public"."sales_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."sales_orders" TO "anon";
GRANT ALL ON TABLE "public"."sales_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_orders" TO "service_role";



GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."user_usage" TO "anon";
GRANT ALL ON TABLE "public"."user_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."user_usage" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







