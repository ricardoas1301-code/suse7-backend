-- DEV.V2.SIGNUP-TWOPHASE-IMPLEMENTATION.18
-- Pending signup intent (server-controlled, s7_private) + atomic birth completion RPC.

CREATE SCHEMA IF NOT EXISTS s7_private;

CREATE TABLE IF NOT EXISTS s7_private.signup_pending_births (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_token_hash text NOT NULL,
  normalized_email text NOT NULL,
  auth_user_id uuid NULL,
  status text NOT NULL DEFAULT 'PENDING',
  profile_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_type text NOT NULL,
  document_version text NOT NULL,
  document_hash text NOT NULL,
  source text NOT NULL DEFAULT 'SIGNUP',
  scrolled_to_end boolean NOT NULL DEFAULT true,
  client_accepted_at timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  bound_at timestamptz NULL,
  completed_at timestamptz NULL,
  aborted_at timestamptz NULL,
  failure_reason text NULL,
  CONSTRAINT signup_pending_births_status_chk CHECK (
    status IN ('PENDING', 'BOUND_WAITING_CONFIRMATION', 'COMPLETED', 'EXPIRED', 'ABORTED', 'FAILED')
  ),
  CONSTRAINT signup_pending_births_correlation_token_hash_uniq UNIQUE (correlation_token_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS signup_pending_births_auth_user_id_uniq
  ON s7_private.signup_pending_births (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signup_pending_births_email_status_idx
  ON s7_private.signup_pending_births (normalized_email, status);

CREATE INDEX IF NOT EXISTS signup_pending_births_expires_idx
  ON s7_private.signup_pending_births (expires_at)
  WHERE status IN ('PENDING', 'BOUND_WAITING_CONFIRMATION');

REVOKE ALL ON TABLE s7_private.signup_pending_births FROM PUBLIC;
GRANT ALL ON TABLE s7_private.signup_pending_births TO service_role;

COMMENT ON TABLE s7_private.signup_pending_births IS
  'Intent de signup pré-auth + evidência jurídica. Service-role only; não exposto ao PostgREST anon/authenticated.';

-- Atomic birth: profile + legal + primary company + recipients (mesma transação PostgreSQL).
CREATE OR REPLACE FUNCTION s7_private.bootstrap_signup_primary_recipients(
  p_auth_user_id uuid,
  p_company_id uuid,
  p_trade_name text,
  p_email text,
  p_whatsapp text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
DECLARE
  v_group_id uuid;
  v_label text;
  v_email text;
  v_whatsapp text;
  v_now timestamptz := now();
  v_evt record;
  v_channels text[];
  v_meta jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'ensured', false, 'reason', 'no_company');
  END IF;

  v_email := lower(trim(COALESCE(p_email, '')));
  v_whatsapp := regexp_replace(COALESCE(p_whatsapp, ''), '\D', '', 'g');

  IF v_email = '' OR v_whatsapp = '' THEN
    RETURN jsonb_build_object('ok', true, 'ensured', false, 'reason', 'incomplete_company_contact');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.s7_notification_recipients
    WHERE seller_id = p_auth_user_id AND is_primary = true
  ) THEN
    SELECT recipient_group_id INTO v_group_id
    FROM public.s7_notification_recipients
    WHERE seller_id = p_auth_user_id AND is_primary = true
    ORDER BY created_at ASC
    LIMIT 1;

    RETURN jsonb_build_object(
      'ok', true,
      'ensured', false,
      'reason', 'already_exists',
      'group_id', v_group_id
    );
  END IF;

  v_group_id := gen_random_uuid();
  v_label := COALESCE(NULLIF(trim(p_trade_name), ''), 'Empresa principal');
  v_meta := jsonb_build_object('recipient_kind', 'PRIMARY_COMPANY');

  INSERT INTO public.s7_notification_recipients (
    seller_id,
    recipient_group_id,
    channel,
    destination,
    label,
    is_active,
    is_primary,
    seller_company_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES
    (p_auth_user_id, v_group_id, 'email', v_email, v_label, true, true, p_company_id, v_meta, v_now, v_now),
    (p_auth_user_id, v_group_id, 'whatsapp', v_whatsapp, v_label, true, true, p_company_id, v_meta, v_now, v_now);

  FOR v_evt IN
    SELECT category_code, type_key, supported_channels
    FROM public.s7_notification_event_types
    WHERE is_active = true
      AND category_code <> 'devcenter'
  LOOP
    v_channels := COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(v_evt.supported_channels)),
      ARRAY[]::text[]
    );

    IF 'email' = ANY (v_channels) THEN
      INSERT INTO public.s7_notification_event_delivery_rules (
        seller_id, category_code, type_key, recipient_group_id, channel, enabled, created_at, updated_at
      )
      VALUES (p_auth_user_id, v_evt.category_code, v_evt.type_key, v_group_id, 'email', true, v_now, v_now)
      ON CONFLICT DO NOTHING;
    END IF;

    IF 'whatsapp' = ANY (v_channels) THEN
      INSERT INTO public.s7_notification_event_delivery_rules (
        seller_id, category_code, type_key, recipient_group_id, channel, enabled, created_at, updated_at
      )
      VALUES (p_auth_user_id, v_evt.category_code, v_evt.type_key, v_group_id, 'whatsapp', true, v_now, v_now)
      ON CONFLICT DO NOTHING;
    END IF;

    IF 'in_app' = ANY (v_channels) THEN
      INSERT INTO public.s7_notification_preferences (
        seller_id, category_code, type_key, channel, enabled, created_at, updated_at
      )
      VALUES (p_auth_user_id, v_evt.category_code, v_evt.type_key, 'in_app', true, v_now, v_now)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.s7_notification_recipients
  SET metadata = v_meta || jsonb_build_object('bootstrap_preferences_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      updated_at = v_now
  WHERE seller_id = p_auth_user_id AND recipient_group_id = v_group_id;

  RETURN jsonb_build_object('ok', true, 'ensured', true, 'group_id', v_group_id);
END;
$$;

REVOKE ALL ON FUNCTION s7_private.bootstrap_signup_primary_recipients(uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION s7_private.bootstrap_signup_primary_recipients(uuid, uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION s7_private.complete_signup_birth_once(p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
DECLARE
  v_user auth.users%ROWTYPE;
  v_pending s7_private.signup_pending_births%ROWTYPE;
  v_cnpj text;
  v_company_name text;
  v_trade_name text;
  v_company_id uuid;
  v_legal_exists boolean;
  v_profile_exists boolean;
  v_recipient_result jsonb;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_USER_ID');
  END IF;

  SELECT * INTO v_user FROM auth.users WHERE id = p_auth_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND');
  END IF;

  IF v_user.email_confirmed_at IS NULL AND v_user.confirmed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_NOT_CONFIRMED');
  END IF;

  SELECT * INTO v_pending
  FROM s7_private.signup_pending_births
  WHERE auth_user_id = p_auth_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_NOT_FOUND');
  END IF;

  IF v_pending.status = 'COMPLETED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'ALREADY_COMPLETED',
      'idempotent', true,
      'pending_id', v_pending.id
    );
  END IF;

  IF v_pending.status NOT IN ('BOUND_WAITING_CONFIRMATION') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'status', v_pending.status);
  END IF;

  IF v_pending.expires_at < now() THEN
    UPDATE s7_private.signup_pending_births
    SET status = 'EXPIRED', failure_reason = 'TTL_EXPIRED'
    WHERE id = v_pending.id;
    RETURN jsonb_build_object('ok', false, 'code', 'EXPIRED');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id = p_auth_user_id) INTO v_profile_exists;

  IF NOT v_profile_exists THEN
    INSERT INTO public.profiles (
      id,
      nome,
      nome_loja,
      email,
      whatsapp,
      telefone,
      cpf_cnpj,
      cep,
      endereco,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
      imposto_percentual,
      primeiro_login,
      photo_url,
      created_at,
      last_login
    )
    VALUES (
      p_auth_user_id,
      NULLIF(trim(v_pending.profile_payload->>'nome'), ''),
      NULLIF(trim(v_pending.profile_payload->>'nome_loja'), ''),
      lower(trim(v_user.email)),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'whatsapp', ''), '\D', '', 'g'), ''),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'telefone', ''), '\D', '', 'g'), ''),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'cpf_cnpj', ''), '\D', '', 'g'), ''),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'cep', ''), '\D', '', 'g'), ''),
      NULLIF(trim(v_pending.profile_payload->>'endereco'), ''),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'numero', ''), '\D', '', 'g'), ''),
      NULLIF(trim(v_pending.profile_payload->>'complemento'), ''),
      NULLIF(trim(v_pending.profile_payload->>'bairro'), ''),
      NULLIF(trim(v_pending.profile_payload->>'cidade'), ''),
      NULLIF(trim(v_pending.profile_payload->>'estado'), ''),
      CASE
        WHEN NULLIF(trim(v_pending.profile_payload->>'imposto_percentual'), '') IS NULL THEN NULL
        ELSE (v_pending.profile_payload->>'imposto_percentual')::numeric
      END,
      false,
      COALESCE(NULLIF(trim(v_pending.profile_payload->>'photo_url'), ''), ''),
      now(),
      now()
    );
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.legal_document_acceptances
    WHERE user_id = p_auth_user_id
      AND document_type = v_pending.document_type
      AND document_version = v_pending.document_version
  ) INTO v_legal_exists;

  IF NOT v_legal_exists THEN
    INSERT INTO public.legal_document_acceptances (
      user_id,
      document_type,
      document_version,
      document_hash,
      accepted_at,
      source,
      scrolled_to_end
    )
    VALUES (
      p_auth_user_id,
      v_pending.document_type,
      v_pending.document_version,
      v_pending.document_hash,
      v_pending.client_accepted_at,
      v_pending.source,
      v_pending.scrolled_to_end
    );
  END IF;

  v_cnpj := regexp_replace(COALESCE(v_pending.profile_payload->>'cpf_cnpj', ''), '\D', '', 'g');
  IF length(v_cnpj) = 14 THEN
    v_company_name := COALESCE(
      NULLIF(trim(v_pending.profile_payload->>'nome_loja'), ''),
      NULLIF(trim(v_pending.profile_payload->>'nome'), ''),
      lower(trim(v_user.email))
    );
    v_trade_name := COALESCE(NULLIF(trim(v_pending.profile_payload->>'nome_loja'), ''), v_company_name);

    INSERT INTO public.seller_companies (
      user_id,
      company_name,
      trade_name,
      document_cnpj,
      is_primary,
      active,
      contact_email,
      whatsapp
    )
    VALUES (
      p_auth_user_id,
      v_company_name,
      v_trade_name,
      v_cnpj,
      true,
      true,
      lower(trim(v_user.email)),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'whatsapp', ''), '\D', '', 'g'), '')
    )
    ON CONFLICT (user_id, document_cnpj) DO NOTHING
    RETURNING id INTO v_company_id;

    IF v_company_id IS NULL AND length(v_cnpj) = 14 THEN
      SELECT id INTO v_company_id
      FROM public.seller_companies
      WHERE user_id = p_auth_user_id AND document_cnpj = v_cnpj
      LIMIT 1;
    END IF;
  END IF;

  IF v_company_id IS NOT NULL THEN
    v_recipient_result := s7_private.bootstrap_signup_primary_recipients(
      p_auth_user_id,
      v_company_id,
      v_trade_name,
      lower(trim(v_user.email)),
      NULLIF(regexp_replace(COALESCE(v_pending.profile_payload->>'whatsapp', ''), '\D', '', 'g'), '')
    );
  ELSE
    v_recipient_result := jsonb_build_object('ok', true, 'ensured', false, 'reason', 'no_company_for_recipients');
  END IF;

  UPDATE s7_private.signup_pending_births
  SET status = 'COMPLETED',
      completed_at = now(),
      failure_reason = NULL
  WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'COMPLETED',
    'pending_id', v_pending.id,
    'company_created', v_company_id IS NOT NULL,
    'company_id', v_company_id,
    'recipient_bootstrap', v_recipient_result
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRANSACTION_FAILED', 'message', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION s7_private.complete_signup_birth_once(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION s7_private.complete_signup_birth_once(uuid) TO service_role;

COMMENT ON FUNCTION s7_private.complete_signup_birth_once(uuid) IS
  'Materializa profile + legal + company principal + recipients atomicamente na mesma transação PostgreSQL.';

-- Wrappers public.* — invocáveis via Supabase RPC com service_role; REVOKE PUBLIC.
CREATE OR REPLACE FUNCTION public.s7_signup_pending_birth_create(
  p_correlation_token_hash text,
  p_normalized_email text,
  p_profile_payload jsonb,
  p_document_type text,
  p_document_version text,
  p_document_hash text,
  p_source text,
  p_scrolled_to_end boolean,
  p_client_accepted_at timestamptz,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
DECLARE
  v_row s7_private.signup_pending_births%ROWTYPE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users WHERE lower(trim(email)) = lower(trim(p_normalized_email))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_ALREADY_REGISTERED');
  END IF;

  IF length(regexp_replace(COALESCE(p_profile_payload->>'cpf_cnpj', ''), '\D', '', 'g')) = 14
     AND EXISTS (
       SELECT 1 FROM public.seller_companies
       WHERE document_cnpj = regexp_replace(COALESCE(p_profile_payload->>'cpf_cnpj', ''), '\D', '', 'g')
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CNPJ_ALREADY_REGISTERED');
  END IF;

  INSERT INTO s7_private.signup_pending_births (
    correlation_token_hash,
    normalized_email,
    status,
    profile_payload,
    document_type,
    document_version,
    document_hash,
    source,
    scrolled_to_end,
    client_accepted_at,
    server_received_at,
    expires_at
  )
  VALUES (
    p_correlation_token_hash,
    lower(trim(p_normalized_email)),
    'PENDING',
    COALESCE(p_profile_payload, '{}'::jsonb),
    p_document_type,
    p_document_version,
    lower(trim(p_document_hash)),
    COALESCE(NULLIF(trim(p_source), ''), 'SIGNUP'),
    COALESCE(p_scrolled_to_end, true),
    p_client_accepted_at,
    now(),
    p_expires_at
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'pending_id', v_row.id,
    'expires_at', v_row.expires_at,
    'server_received_at', v_row.server_received_at
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE_PENDING');
END;
$$;

CREATE OR REPLACE FUNCTION public.s7_signup_pending_birth_bind(
  p_correlation_token_hash text,
  p_auth_user_id uuid,
  p_auth_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
DECLARE
  v_user auth.users%ROWTYPE;
  v_pending s7_private.signup_pending_births%ROWTYPE;
BEGIN
  SELECT * INTO v_pending
  FROM s7_private.signup_pending_births
  WHERE correlation_token_hash = p_correlation_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_NOT_FOUND');
  END IF;

  IF v_pending.status NOT IN ('PENDING') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATUS', 'status', v_pending.status);
  END IF;

  IF v_pending.expires_at < now() THEN
    UPDATE s7_private.signup_pending_births SET status = 'EXPIRED', failure_reason = 'TTL_EXPIRED' WHERE id = v_pending.id;
    RETURN jsonb_build_object('ok', false, 'code', 'EXPIRED');
  END IF;

  SELECT * INTO v_user FROM auth.users WHERE id = p_auth_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_USER_NOT_FOUND');
  END IF;

  IF lower(trim(v_user.email)) <> lower(trim(p_auth_email)) OR lower(trim(v_user.email)) <> v_pending.normalized_email THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_MISMATCH');
  END IF;

  UPDATE s7_private.signup_pending_births
  SET auth_user_id = p_auth_user_id,
      status = 'BOUND_WAITING_CONFIRMATION',
      bound_at = now()
  WHERE id = v_pending.id;

  RETURN jsonb_build_object('ok', true, 'code', 'BOUND', 'pending_id', v_pending.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.s7_signup_pending_birth_abort(
  p_correlation_token_hash text,
  p_reason text DEFAULT 'SIGNUP_FAILED'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
DECLARE
  v_pending s7_private.signup_pending_births%ROWTYPE;
BEGIN
  SELECT * INTO v_pending
  FROM s7_private.signup_pending_births
  WHERE correlation_token_hash = p_correlation_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_NOT_FOUND');
  END IF;

  IF v_pending.status = 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_COMPLETED');
  END IF;

  UPDATE s7_private.signup_pending_births
  SET status = 'ABORTED',
      aborted_at = now(),
      failure_reason = left(COALESCE(p_reason, 'SIGNUP_FAILED'), 500)
  WHERE id = v_pending.id;

  RETURN jsonb_build_object('ok', true, 'code', 'ABORTED');
END;
$$;

CREATE OR REPLACE FUNCTION public.s7_complete_signup_birth_once(p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, s7_private, auth
AS $$
  SELECT s7_private.complete_signup_birth_once(p_auth_user_id);
$$;

REVOKE ALL ON FUNCTION public.s7_signup_pending_birth_create(text, text, jsonb, text, text, text, text, boolean, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.s7_signup_pending_birth_bind(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.s7_signup_pending_birth_abort(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.s7_complete_signup_birth_once(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.s7_signup_pending_birth_create(text, text, jsonb, text, text, text, text, boolean, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.s7_signup_pending_birth_bind(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.s7_signup_pending_birth_abort(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.s7_complete_signup_birth_once(uuid) TO service_role;
