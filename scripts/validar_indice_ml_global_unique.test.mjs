#!/usr/bin/env node
import assert from "node:assert/strict";
import { validarIndiceMlGlobalUnique, normalizarPredicateIndexdef } from "./lib/validar_indice_ml_global_unique.mjs";

const DEF_SEM_CAST =
  "CREATE UNIQUE INDEX marketplace_accounts_global_active_external_uidx ON public.marketplace_accounts USING btree (marketplace, external_seller_id) WHERE (status IS DISTINCT FROM 'removed')";

const DEF_COM_CAST =
  "CREATE UNIQUE INDEX marketplace_accounts_global_active_external_uidx ON public.marketplace_accounts USING btree (marketplace, external_seller_id) WHERE (status IS DISTINCT FROM 'removed'::text)";

const DEF_INCORRETO =
  "CREATE UNIQUE INDEX marketplace_accounts_global_active_external_uidx ON public.marketplace_accounts USING btree (marketplace, external_seller_id) WHERE (status = 'active')";

// 1. predicate sem cast
{
  const r = validarIndiceMlGlobalUnique({ index_exists: true, index_definition: DEF_SEM_CAST });
  assert.equal(r.pass, true, "sem cast deve PASS");
  assert.equal(r.predicate_ok, true);
  assert.equal(r.columns_ok, true);
  assert.equal(r.unique, true);
}

// 2. predicate com ::text (pg_indexes)
{
  const r = validarIndiceMlGlobalUnique({ index_exists: true, index_definition: DEF_COM_CAST });
  assert.equal(r.pass, true, "com ::text deve PASS");
  assert.equal(r.predicate_ok, true);
}

// 2b. predicate com ::text escapado (schema dump)
{
  const DEF_DUMP =
    'CREATE UNIQUE INDEX "marketplace_accounts_global_active_external_uidx" ON "public"."marketplace_accounts" USING "btree" ("marketplace", "external_seller_id") WHERE ("status" IS DISTINCT FROM \'removed\'::"text");';
  const r = validarIndiceMlGlobalUnique({ index_exists: true, index_definition: DEF_DUMP });
  assert.equal(r.pass, true, "dump escapado deve PASS");
  assert.equal(r.predicate_ok, true);
}

// 3. predicate incorreto → FAIL
{
  const r = validarIndiceMlGlobalUnique({ index_exists: true, index_definition: DEF_INCORRETO });
  assert.equal(r.pass, false, "predicate incorreto deve FAIL");
  assert.equal(r.predicate_ok, false);
}

// normalização
assert.match(
  normalizarPredicateIndexdef(DEF_COM_CAST),
  /status is distinct from 'removed'/,
  "normalização remove ::text",
);

console.log(JSON.stringify({ pass: true, tests: 4, module: "validar_indice_ml_global_unique" }));
