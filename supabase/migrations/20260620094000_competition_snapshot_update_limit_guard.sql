-- ======================================================================
-- S7 — Concorrência: limite de ativos sem bloquear update de snapshot
-- Regra:
-- - Mantém limite 9 para INSERT, reativação e mudanças de "membership"
-- - NÃO bloqueia update operacional (ex.: last_captured_at/last_seen_price)
--   quando o concorrente já está ativo no mesmo agrupamento.
-- ======================================================================

CREATE OR REPLACE FUNCTION public.s7_competition_enforce_active_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- UPDATE operacional do mesmo concorrente ativo (sem troca de grupo) não deve
  -- revalidar limite de cadastro. Evita bloquear snapshot diário/touch.
  IF TG_OP = 'UPDATE'
     AND OLD.is_active IS TRUE
     AND NEW.is_active IS TRUE
     AND NEW.user_id = OLD.user_id
     AND NEW.marketplace = OLD.marketplace
     AND COALESCE(NEW.monitored_listing_id::text, '') = COALESCE(OLD.monitored_listing_id::text, '')
     AND COALESCE(NEW.product_id::text, '') = COALESCE(OLD.product_id::text, '')
  THEN
    RETURN NEW;
  END IF;

  IF NEW.monitored_listing_id IS NOT NULL THEN
    SELECT count(*) INTO active_count
    FROM public.competition_competitors c
    WHERE c.user_id = NEW.user_id
      AND c.marketplace = NEW.marketplace
      AND c.monitored_listing_id = NEW.monitored_listing_id
      AND c.is_active = true
      AND c.id <> NEW.id;

    IF active_count >= 9 THEN
      RAISE EXCEPTION 'Limite de 9 concorrentes ativos por anúncio monitorado atingido.'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  SELECT count(*) INTO active_count
  FROM public.competition_competitors c
  WHERE c.user_id = NEW.user_id
    AND c.marketplace = NEW.marketplace
    AND c.product_id = NEW.product_id
    AND c.is_active = true
    AND c.id <> NEW.id;

  IF active_count >= 9 THEN
    RAISE EXCEPTION 'Limite de 9 concorrentes ativos por produto atingido.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
