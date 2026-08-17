with janela as (
  select
    ((date_trunc('day', now() at time zone 'America/Sao_Paulo')
      at time zone 'America/Sao_Paulo')) as inicio_utc
),
snap_ult as (
  select distinct on (s.competitor_id)
    s.competitor_id,
    s.captured_at as ultimo_snapshot_captured_at,
    s.raw_snapshot
  from competition_snapshots s
  order by s.competitor_id, s.captured_at desc
),
base as (
  select
    c.id as competitor_id,
    c.user_id,
    c.product_id,
    c.marketplace,
    c.marketplace_account_id,
    c.competitor_listing_id,
    c.competitor_listing_status,
    c.last_captured_at,
    c.updated_at,
    su.ultimo_snapshot_captured_at,
    su.raw_snapshot,
    greatest(
      coalesce(c.last_captured_at, 'epoch'::timestamptz),
      coalesce(su.ultimo_snapshot_captured_at, 'epoch'::timestamptz)
    ) as ultima_verificacao_efetiva
  from competition_competitors c
  left join snap_ult su on su.competitor_id = c.id
  where c.is_active = true
),
pendentes as (
  select b.*
  from base b
  cross join janela j
  where b.ultima_verificacao_efetiva < j.inicio_utc
),
conta as (
  select
    p.*,
    ma.external_seller_id
  from pendentes p
  left join marketplace_accounts ma
    on ma.id = p.marketplace_account_id
   and ma.user_id = p.user_id
   and ma.marketplace = p.marketplace
),
token_info as (
  select
    c.*,
    coalesce(ts.ml_user_id, tf.ml_user_id) as token_ml_user_id,
    coalesce(ts.expires_at, tf.expires_at) as token_expires_at,
    coalesce(ts.refresh_token, tf.refresh_token) as token_refresh_token,
    coalesce(ts.access_token, tf.access_token) as token_access_token,
    case
      when ts.ml_user_id is not null then 'scoped_account_token'
      when tf.ml_user_id is not null then 'fallback_user_token'
      else 'no_token_row'
    end as token_source
  from conta c
  left join lateral (
    select
      t.ml_user_id,
      t.expires_at,
      t.refresh_token,
      t.access_token
    from ml_tokens t
    where t.user_id = c.user_id
      and t.marketplace = c.marketplace
      and c.external_seller_id is not null
      and t.ml_user_id = c.external_seller_id
    order by t.updated_at desc
    limit 1
  ) ts on true
  left join lateral (
    select
      t.ml_user_id,
      t.expires_at,
      t.refresh_token,
      t.access_token
    from ml_tokens t
    where t.user_id = c.user_id
      and t.marketplace = c.marketplace
    order by t.updated_at desc
    limit 1
  ) tf on true
)
select
  ti.competitor_id,
  ti.product_id,
  ti.competitor_listing_id,
  ti.marketplace_account_id,
  ti.external_seller_id,
  ti.competitor_listing_status,
  ti.last_captured_at,
  ti.ultimo_snapshot_captured_at,
  nullif(ti.ultima_verificacao_efetiva, 'epoch'::timestamptz) as ultima_verificacao_efetiva,
  ti.token_source,
  ti.token_ml_user_id,
  ti.token_expires_at,
  case
    when ti.token_access_token is null
      or (ti.token_expires_at is not null and ti.token_expires_at <= now() and coalesce(ti.token_refresh_token, '') = '')
      then 'token invalido/ausente'

    when lower(coalesce(ti.competitor_listing_status, '')) in ('not_found', 'closed', 'inactive', 'unavailable')
      then 'anuncio removido/404'

    when lower(coalesce(ti.competitor_listing_status, '')) in ('forbidden', 'under_review')
      then '403 ML'

    when coalesce(ti.raw_snapshot::text, '') ilike '%timeout%'
      then 'timeout'

    else 'erro interno'
  end as causa_provavel,

  case
    when ti.token_access_token is null then 'sem linha/token no ml_tokens'
    when (ti.token_expires_at is not null and ti.token_expires_at <= now() and coalesce(ti.token_refresh_token, '') = '')
      then 'token expirado e sem refresh_token'
    when lower(coalesce(ti.competitor_listing_status, '')) in ('not_found', 'closed', 'inactive', 'unavailable')
      then 'status do anuncio indica indisponivel/encerrado'
    when lower(coalesce(ti.competitor_listing_status, '')) in ('forbidden', 'under_review')
      then 'status do anuncio indica bloqueio/permissao'
    when coalesce(ti.raw_snapshot::text, '') ilike '%timeout%'
      then 'evidencia de timeout no raw_snapshot'
    else 'pendente sem evidencia objetiva de token/status; revisar logs do job (sample_results/error_code)'
  end as evidencia

from token_info ti
order by ti.ultima_verificacao_efetiva asc nulls first, ti.updated_at asc
limit 100;
