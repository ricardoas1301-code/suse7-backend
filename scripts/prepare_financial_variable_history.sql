-- S7-HIST-004
-- Estrutura base para versionamento de variaveis financeiras.
-- Todos os valores monetarios usam NUMERIC (sem float).

create table if not exists product_cost_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  seller_company_id uuid null,
  product_id uuid not null,
  valor_anterior numeric(18,6) null,
  valor_novo numeric(18,6) not null,
  effective_from timestamptz not null,
  effective_to timestamptz null,
  source text null,
  reason text null,
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_product_cost_history_lookup
  on product_cost_history (user_id, product_id, effective_from desc);

create table if not exists seller_tax_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  seller_company_id uuid not null,
  tax_key text not null,
  valor_anterior numeric(18,6) null,
  valor_novo numeric(18,6) not null,
  effective_from timestamptz not null,
  effective_to timestamptz null,
  source text null,
  reason text null,
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_seller_tax_history_lookup
  on seller_tax_history (user_id, seller_company_id, tax_key, effective_from desc);

create table if not exists seller_operational_cost_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  seller_company_id uuid not null,
  cost_key text not null,
  valor_anterior numeric(18,6) null,
  valor_novo numeric(18,6) not null,
  effective_from timestamptz not null,
  effective_to timestamptz null,
  source text null,
  reason text null,
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_seller_operational_cost_history_lookup
  on seller_operational_cost_history (user_id, seller_company_id, cost_key, effective_from desc);

create table if not exists seller_pricing_parameter_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  seller_company_id uuid not null,
  parameter_key text not null,
  valor_anterior numeric(18,6) null,
  valor_novo numeric(18,6) not null,
  effective_from timestamptz not null,
  effective_to timestamptz null,
  source text null,
  reason text null,
  created_by text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_seller_pricing_parameter_history_lookup
  on seller_pricing_parameter_history (user_id, seller_company_id, parameter_key, effective_from desc);
