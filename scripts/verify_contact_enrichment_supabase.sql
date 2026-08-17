-- =============================================================================
-- Validação pós-migration: Clientes 360 — contato enriquecido
-- Rode no SQL Editor do Supabase APÓS:
--   20260505183000_marketplace_customers_contact_enrichment.sql
-- =============================================================================

-- Colunas existentes (deve retornar 7 linhas com column_name correspondentes)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'marketplace_customers'
  AND column_name IN (
    'email',
    'email_is_masked',
    'phone',
    'phone_area_code',
    'phone_number',
    'whatsapp',
    'whatsapp_e164',
    'contact_source',
    'contact_updated_at'
  )
ORDER BY column_name;

-- Contagens
SELECT
  COUNT(*)::bigint AS total_clientes,
  COUNT(*) FILTER (WHERE email IS NOT NULL AND trim(email) <> '')::bigint AS com_email,
  COUNT(*) FILTER (WHERE whatsapp_e164 IS NOT NULL AND trim(whatsapp_e164) <> '')::bigint AS com_whatsapp_e164,
  COUNT(*) FILTER (
    WHERE (email IS NULL OR trim(email) = '')
      AND (phone IS NULL OR trim(phone) = '')
      AND (whatsapp IS NULL OR trim(whatsapp) = '')
      AND (whatsapp_e164 IS NULL OR trim(whatsapp_e164) = '')
  )::bigint AS sem_contato
FROM public.marketplace_customers;

-- Distribuição por fonte (quando preenchido)
SELECT contact_source, COUNT(*)::bigint AS qtd
FROM public.marketplace_customers
WHERE contact_source IS NOT NULL AND trim(contact_source) <> ''
GROUP BY contact_source
ORDER BY qtd DESC;

-- Amostra: apenas prefixo de e-mail e últimos dígitos do telefone (não exportar dados sensíveis)
SELECT
  id,
  left(trim(email), 3) || '***' AS email_prefixo_mascarado,
  email_is_masked,
  phone_area_code,
  phone_number,
  CASE
    WHEN whatsapp_e164 IS NOT NULL AND length(regexp_replace(whatsapp_e164, '\D', '', 'g')) >= 4
    THEN '***' || right(regexp_replace(whatsapp_e164, '\D', '', 'g'), 4)
    ELSE NULL
  END AS whatsapp_e164_final_mascarado,
  contact_source,
  contact_updated_at IS NOT NULL AS tem_contact_updated_at
FROM public.marketplace_customers
WHERE email IS NOT NULL OR whatsapp_e164 IS NOT NULL OR phone IS NOT NULL
ORDER BY updated_at DESC NULLS LAST
LIMIT 15;
