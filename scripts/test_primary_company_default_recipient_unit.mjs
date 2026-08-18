#!/usr/bin/env node
/**
 * Destinatário padrão da empresa principal — testes de unidade (sem rede/DB).
 *   node scripts/test_primary_company_default_recipient_unit.mjs
 */

import {
  S7_RECIPIENT_KIND,
  DEFAULT_RECIPIENT_ERROR,
  isPrimaryCompanyRecipientRow,
  isPrimaryCompanyRecipientGroup,
  canDeleteRecipientGroup,
  canEditPrimaryRecipientContactFields,
  hasBootstrapPreferencesCompleted,
  isRecipientLabelCustomized,
  mergeRecipientMetadata,
} from "../src/domain/notifications/central/recipients/defaultRecipientPolicy.js";
import { resolvePrimaryCompanyContactSources } from "../src/domain/notifications/central/recipients/primaryCompanyDefaultRecipientService.js";
import { aggregateRecipientGroups } from "../src/domain/notifications/central/seller/sellerNotificationRecipientGroupsService.js";

/** @type {string[]} */
const failures = [];
let passed = 0;

function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

// Policy — identificação estrutural
{
  assert("row: is_primary=true", isPrimaryCompanyRecipientRow({ is_primary: true }));
  assert("row: metadata recipient_kind", isPrimaryCompanyRecipientRow({ metadata: { recipient_kind: S7_RECIPIENT_KIND.PRIMARY_COMPANY } }));
  assert("row: comum=false", !isPrimaryCompanyRecipientRow({ is_primary: false, metadata: {} }));
  assert("group: is_primary", isPrimaryCompanyRecipientGroup({ is_primary: true }));
  assert("delete bloqueado padrão", !canDeleteRecipientGroup({ is_primary: true }));
  assert("delete permitido comum", canDeleteRecipientGroup({ is_primary: false }));
  assert("contato bloqueado padrão", !canEditPrimaryRecipientContactFields({ is_primary: true }));
  assert("contato permitido comum", canEditPrimaryRecipientContactFields({ is_primary: false }));
}

// Bootstrap metadata
{
  assert("bootstrap pendente", !hasBootstrapPreferencesCompleted({}));
  assert("bootstrap concluído", hasBootstrapPreferencesCompleted({ bootstrap_preferences_at: "2026-08-12T12:00:00.000Z" }));
  assert("label customizado", isRecipientLabelCustomized({ label_customized: true }));
  assert("merge metadata", mergeRecipientMetadata({ a: 1 }, { b: 2 }).a === 1 && mergeRecipientMetadata({ a: 1 }, { b: 2 }).b === 2);
}

// SSOT contato empresa principal
{
  const contact = resolvePrimaryCompanyContactSources(
    {
      id: "co-1",
      trade_name: "Loja Alpha",
      contact_email: "contato@alpha.com",
      whatsapp: "11999998888",
    },
    { email: "login@suse7.com", phone: "11888887777" }
  );
  assert("SSOT email empresa", contact.email === "contato@alpha.com");
  assert("SSOT whatsapp empresa", contact.whatsapp === "11999998888");
  assert("label inicial trade_name", contact.tradeName === "Loja Alpha");
  assert("seller_company_id", contact.sellerCompanyId === "co-1");
}

{
  const contact = resolvePrimaryCompanyContactSources(
    { id: "co-2", trade_name: "Beta", whatsapp: "11911112222" },
    { email: "login@suse7.com" }
  );
  assert("fallback email profile", contact.email === "login@suse7.com");
}

// aggregateRecipientGroups propaga is_primary
{
  const groups = aggregateRecipientGroups([
    {
      id: "r-email",
      recipient_group_id: "g1",
      channel: "email",
      destination: "a@b.com",
      label: "Loja Alpha",
      is_primary: true,
      seller_company_id: "co-1",
      metadata: { recipient_kind: S7_RECIPIENT_KIND.PRIMARY_COMPANY },
      is_active: true,
    },
    {
      id: "r-wa",
      recipient_group_id: "g1",
      channel: "whatsapp",
      destination: "11999998888",
      label: "Loja Alpha",
      is_primary: true,
      seller_company_id: "co-1",
      metadata: { recipient_kind: S7_RECIPIENT_KIND.PRIMARY_COMPANY },
      is_active: true,
    },
    {
      id: "r2",
      recipient_group_id: "g2",
      channel: "email",
      destination: "x@y.com",
      label: "Zeta",
      is_primary: false,
      is_active: true,
    },
  ]);
  assert("groups length", groups.length === 2);
  assert("primary first", groups[0].is_primary === true);
  assert("primary group_id", groups[0].group_id === "g1");
  assert("primary seller_company_id", groups[0].seller_company_id === "co-1");
  assert("primary metadata kind", groups[0].metadata?.recipient_kind === S7_RECIPIENT_KIND.PRIMARY_COMPANY);
  assert("comum is_primary false", groups[1].is_primary === false);
}

// Erros canônicos exportados
{
  assert("error delete", DEFAULT_RECIPIENT_ERROR.PRIMARY_DELETE_FORBIDDEN === "PRIMARY_RECIPIENT_DELETE_FORBIDDEN");
  assert("error contact", DEFAULT_RECIPIENT_ERROR.PRIMARY_CONTACT_LOCKED === "PRIMARY_RECIPIENT_CONTACT_LOCKED");
}

console.log(`[test_primary_company_default_recipient_unit] ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("Failures:", failures);
  process.exit(1);
}
console.log("[test_primary_company_default_recipient_unit] OK");
