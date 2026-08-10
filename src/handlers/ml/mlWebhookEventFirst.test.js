import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMlWebhookDedupeKey,
  extractMlWebhookMeta,
  inferOrderIdFromMlWebhook,
} from "./_helpers/mlWebhookPayload.js";
import { classifyMercadoLivreAccountCandidates } from "./_helpers/resolveMercadoLivreAccountFromWebhook.js";

describe("mlWebhookPayload — orders_v2", () => {
  it("extrai order_id de resource /orders/{id}", () => {
    assert.equal(inferOrderIdFromMlWebhook("orders_v2", "/orders/2000017804069474"), "2000017804069474");
  });

  it("dedupe_key canônica usa _id quando presente", () => {
    const k1 = buildMlWebhookDedupeKey({
      _id: "abc-123",
      topic: "orders_v2",
      resource: "/orders/1",
      sent: "2026-08-10T12:00:00.000Z",
    });
    const k2 = buildMlWebhookDedupeKey({
      _id: "abc-123",
      topic: "orders_v2",
      resource: "/orders/999",
      sent: "2026-08-10T13:00:00.000Z",
    });
    assert.equal(k1, "mlwh:abc-123");
    assert.equal(k1, k2);
  });

  it("dedupe hash quando _id ausente", () => {
    const payload = {
      topic: "orders_v2",
      resource: "/orders/42",
      sent: "2026-08-10T12:00:00.000Z",
    };
    assert.match(buildMlWebhookDedupeKey(payload), /^mlwh:hash:[a-f0-9]{32}$/);
    assert.equal(buildMlWebhookDedupeKey(payload), buildMlWebhookDedupeKey(payload));
  });

  it("meta extrai user_id e application_id", () => {
    const meta = extractMlWebhookMeta({
      topic: "orders_v2",
      resource: "/orders/1",
      user_id: "2350765542",
      application_id: "123456789",
      _id: "evt-1",
    });
    assert.equal(meta.topic, "orders_v2");
    assert.equal(meta.marketplaceUserId, "2350765542");
    assert.equal(meta.applicationId, "123456789");
  });
});

describe("classifyMercadoLivreAccountCandidates — multi-tenant", () => {
  it("unique quando 1 conta", () => {
    const r = classifyMercadoLivreAccountCandidates([
      { id: "acc-b", user_id: "tenant-b", external_seller_id: "2350765542" },
    ]);
    assert.equal(r.kind, "unique");
    assert.equal(r.account?.id, "acc-b");
  });

  it("ambiguous quando >1 conta para mesmo seller (677620487)", () => {
    const r = classifyMercadoLivreAccountCandidates([
      { id: "7daed948-627b-4180-8550-d8519b6cde23", user_id: "c8a62ec6", external_seller_id: "677620487" },
      { id: "6d6a8486-5152-4d2d-9859-12917fae9f20", user_id: "7f351439", external_seller_id: "677620487" },
    ]);
    assert.equal(r.kind, "ambiguous");
    assert.equal(r.account, null);
    assert.equal(r.candidates.length, 2);
  });

  it("none quando vazio", () => {
    assert.equal(classifyMercadoLivreAccountCandidates([]).kind, "none");
  });
});

describe("watermark — webhook não avança reconciliação", () => {
  it("mlWebhookProcessor não importa advanceMlSalesWatermark", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./mlWebhookProcessor.js", import.meta.url), "utf8"),
    );
    assert.equal(src.includes("advanceMlSalesWatermark"), false);
    assert.equal(src.includes("ml_sales_last_synced_order_created_to"), false);
  });
});

describe("ingest ACK — sem resolução de conta no callback", () => {
  it("mlWebhookRepository não resolve marketplace_account no critical path", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./mlWebhookRepository.js", import.meta.url), "utf8"),
    );
    assert.equal(src.includes("resolveMercadoLivreAccountFromWebhook"), false);
    assert.match(src, /dedupe_key[\s\S]*maybeSingle\(\)/);
  });
});

describe("fila orders_v2 — fairness event-first", () => {
  it("baseline DEV cutoff definido", async () => {
    const { ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO } = await import("./_helpers/mlWebhookEventQueue.js");
    assert.equal(ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO, "2026-08-07T03:00:00.000Z");
  });

  it("processor usa fila com fast lane (não DESC puro)", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./_helpers/mlWebhookEventQueue.js", import.meta.url), "utf8"),
    );
    assert.match(src, /priorityEventIds/);
    assert.match(src, /ascending: false/);
    assert.match(src, /ascending: true/);
    assert.match(src, /lt\("created_at", ML_WEBHOOK_ORDERS_DEV_BASELINE_ISO\)/);
  });
});

describe("multi-tenant processor — WEBHOOK_ACCOUNT_AMBIGUOUS", () => {
  it("pickUniqueAccountFromRows lança ambíguo", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./mlWebhookProcessor.js", import.meta.url), "utf8"),
    );
    assert.match(src, /WEBHOOK_ACCOUNT_AMBIGUOUS/);
    assert.match(src, /pickUniqueAccountFromRows/);
    assert.match(src, /status: "ignored"/);
  });

  it("resolveEventContext usa tenant user_id quando event tem marketplace_account_id + ml user_id", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./mlWebhookProcessor.js", import.meta.url), "utf8"),
    );
    assert.match(src, /attempt: "event_marketplace_account_id"/);
    assert.match(src, /userId: String\(rows\[0\]\.user_id\)/);
    assert.doesNotMatch(src, /return \{ userId: directUserId, marketplaceAccountId, sellerCompanyId \}/);
  });
});

describe("mlWebhookRetry — contrato de retry", () => {
  it("erro transitório reconhecido", async () => {
    const { isMlWebhookTransientError } = await import("./_helpers/mlWebhookRetry.js");
    assert.equal(isMlWebhookTransientError("ML_CLIENT_ID ou ML_CLIENT_SECRET ausentes", "WEBHOOK_PROCESS_ERROR"), true);
    assert.equal(isMlWebhookTransientError("Tokens não encontrados", "WEBHOOK_PROCESS_ERROR"), true);
    assert.equal(isMlWebhookTransientError("account_ambiguous_multi_tenant", "WEBHOOK_ACCOUNT_AMBIGUOUS"), false);
  });

  it("backoff respeita updated_at + attempts", async () => {
    const { isMlWebhookEventRetryDue, calcMlWebhookRetryBackoffMs } = await import("./_helpers/mlWebhookRetry.js");
    const now = Date.parse("2026-08-10T18:00:00.000Z");
    const backoff = calcMlWebhookRetryBackoffMs(1);
    assert.equal(
      isMlWebhookEventRetryDue(
        {
          status: "pending",
          attempts: 1,
          last_error_code: "WEBHOOK_PROCESS_ERROR",
          error_message: "Tokens não encontrados",
          updated_at: new Date(now - backoff - 1000).toISOString(),
        },
        5,
        now,
      ),
      true,
    );
    assert.equal(
      isMlWebhookEventRetryDue(
        {
          status: "pending",
          attempts: 1,
          error_message: "Tokens não encontrados",
          updated_at: new Date(now).toISOString(),
        },
        5,
        now,
      ),
      false,
    );
  });

  it("fila inclui lanes retry e stale", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./_helpers/mlWebhookEventQueue.js", import.meta.url), "utf8"),
    );
    assert.match(src, /retryQuota/);
    assert.match(src, /staleQuota/);
    assert.match(src, /isMlWebhookEventRetryDue/);
    assert.match(src, /isMlWebhookStalePendingEvent/);
  });
});
