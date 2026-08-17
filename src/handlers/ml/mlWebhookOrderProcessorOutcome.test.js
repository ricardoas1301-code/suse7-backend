import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertMlWebhookOrdersV2CanonicalOutcome,
  classifyMlWebhookApplyResult,
  isMlWebhookTerminalIgnoredError,
} from "./_helpers/mlWebhookOrderProcessorOutcome.js";

describe("mlWebhookOrderProcessorOutcome — classificação apply", () => {
  it("PERSISTED quando ok:true com salesOrderId", () => {
    const r = classifyMlWebhookApplyResult({ ok: true, salesOrderId: "so-1" });
    assert.equal(r.outcome, "PERSISTED");
    assert.equal(r.terminal, true);
  });

  it("IGNORED_ENTITLEMENT_BLOCKED quando entitlement_blocked", () => {
    const r = classifyMlWebhookApplyResult({
      ok: false,
      entitlement_blocked: true,
      reason: "baby_quota_hard_paused",
      domain_code: "BABY_HARD_LIMIT_REACHED",
      webhook_ok: true,
    });
    assert.equal(r.outcome, "IGNORED_ENTITLEMENT_BLOCKED");
    assert.equal(r.terminal, true);
    assert.equal(r.reason, "baby_quota_hard_paused");
  });

  it("RETRYABLE_FAILURE quando ok:false genérico", () => {
    const r = classifyMlWebhookApplyResult({ ok: false, reason: "persist_failed" });
    assert.equal(r.outcome, "RETRYABLE_FAILURE");
    assert.equal(r.terminal, false);
  });

  it("DEFINITIVE_SKIP para payload inválido", () => {
    const r = classifyMlWebhookApplyResult({ ok: false, reason: "order_without_id" });
    assert.equal(r.outcome, "DEFINITIVE_SKIP");
    assert.equal(r.terminal, true);
  });
});

function mockSupabaseWithSalesOrder(id) {
  const chain = {
    eq: () => chain,
    maybeSingle: async () => ({ data: id ? { id } : null, error: null }),
  };
  return {
    from: () => ({
      select: () => chain,
    }),
  };
}

describe("mlWebhookOrderProcessorOutcome — assert canonical", () => {
  it("lança ML_WEBHOOK_ENTITLEMENT_BLOCKED — nunca done silencioso", async () => {
    const supabase = mockSupabaseWithSalesOrder(null);
    await assert.rejects(
      () =>
        assertMlWebhookOrdersV2CanonicalOutcome(supabase, {
          applyResult: {
            ok: false,
            entitlement_blocked: true,
            reason: "baby_quota_hard_paused",
          },
          userId: "u1",
          marketplaceAccountId: "acc1",
          externalOrderId: "2000017892149916",
        }),
      (err) => {
        assert.equal(/** @type {any} */ (err).code, "ML_WEBHOOK_ENTITLEMENT_BLOCKED");
        return true;
      },
    );
  });

  it("exige sales_orders canônica mesmo com ok:true", async () => {
    const supabase = mockSupabaseWithSalesOrder(null);
    await assert.rejects(
      () =>
        assertMlWebhookOrdersV2CanonicalOutcome(supabase, {
          applyResult: { ok: true, salesOrderId: "ghost" },
          userId: "u1",
          marketplaceAccountId: "acc1",
          externalOrderId: "42",
        }),
      (err) => {
        assert.equal(/** @type {any} */ (err).code, "ML_WEBHOOK_PERSISTENCE_VERIFICATION_FAILED");
        return true;
      },
    );
  });

  it("retorna PERSISTED quando row existe", async () => {
    const supabase = mockSupabaseWithSalesOrder("so-real");
    const out = await assertMlWebhookOrdersV2CanonicalOutcome(supabase, {
      applyResult: { ok: true, salesOrderId: "so-real" },
      userId: "u1",
      marketplaceAccountId: "acc1",
      externalOrderId: "42",
      hadExistingBeforeApply: false,
    });
    assert.equal(out.outcome, "PERSISTED");
    assert.equal(out.status, "done");
    assert.equal(out.salesOrderId, "so-real");
  });

  it("retorna IDEMPOTENT_ALREADY_PRESENT quando já existia", async () => {
    const supabase = mockSupabaseWithSalesOrder("so-existing");
    const out = await assertMlWebhookOrdersV2CanonicalOutcome(supabase, {
      applyResult: { ok: true, salesOrderId: "so-existing" },
      userId: "u1",
      marketplaceAccountId: "acc1",
      externalOrderId: "42",
      hadExistingBeforeApply: true,
    });
    assert.equal(out.outcome, "IDEMPOTENT_ALREADY_PRESENT");
  });
});

describe("mlWebhookOrderProcessorOutcome — terminal ignored", () => {
  it("reconhece entitlement e ambiguous", () => {
    assert.equal(isMlWebhookTerminalIgnoredError({ code: "ML_WEBHOOK_ENTITLEMENT_BLOCKED" }), true);
    assert.equal(isMlWebhookTerminalIgnoredError({ code: "WEBHOOK_ACCOUNT_AMBIGUOUS" }), true);
    assert.equal(isMlWebhookTerminalIgnoredError({ code: "ML_WEBHOOK_APPLY_RETRYABLE" }), false);
  });
});

describe("mlWebhookProcessor — DONE exige assert canonical", () => {
  it("processor importa gate de outcome antes de marcar done", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./mlWebhookProcessor.js", import.meta.url), "utf8"),
    );
    assert.match(src, /assertMlWebhookOrdersV2CanonicalOutcome/);
    assert.match(src, /isMlWebhookTerminalIgnoredError/);
    assert.match(src, /ML_WEBHOOK_ENTITLEMENT_BLOCKED/);
    assert.doesNotMatch(src, /await applyMlOrderDetailToMarketplaceSales[\s\S]{0,120}status: "done"/);
  });
});
