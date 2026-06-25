// =============================================================================
// Z-API — primeira integração live controlada (Fase 3.5C.1)
// =============================================================================

import { ProviderAdapter } from "../../abstraction/ProviderAdapter.js";
import { S7_DELIVERY_MODE } from "../../abstraction/deliveryMode.js";
import { LIVE_WHATSAPP_CAPABILITIES } from "../../abstraction/providerCapabilities.js";
import { S7_PROVIDER_CHANNEL } from "../../abstraction/providerChannels.js";
import { toProviderResponse } from "../../abstraction/providerResponse.js";
import { buildProviderHealthResult } from "../../abstraction/providerHealthResult.js";
import { assertWhatsAppLiveDeliveryEnabled } from "../../abstraction/providerLiveDeliveryGate.js";
import { resolveZapiProviderSmokeGate } from "../../../sales/manualSaleRayxLiveDelivery.js";
import {
  logProviderBlocked,
  logProviderFail,
  logProviderStart,
  logProviderSuccess,
} from "../../abstraction/providerObservability.js";
import { zapiFetch, resolveZapiHttpConfig } from "../zapiHttpClient.js";

export class ZapiWhatsAppAdapter extends ProviderAdapter {
  constructor() {
    super({
      channel: S7_PROVIDER_CHANNEL.WHATSAPP,
      providerName: "zapi",
      deliveryMode: S7_DELIVERY_MODE.LIVE,
      capabilities: LIVE_WHATSAPP_CAPABILITIES,
    });
  }

  /** @param {import("../../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  async validate(input) {
    const to = String(input.to ?? "").replace(/\D/g, "");
    if (!to || to.length < 10 || to.length > 15) {
      return { ok: false, error: "INVALID_PHONE" };
    }
    return { ok: true };
  }

  async health() {
    const started = Date.now();
    const liveGate = assertWhatsAppLiveDeliveryEnabled();
    if (!liveGate.ok) {
      return buildProviderHealthResult({
        provider: this.providerName,
        ok: false,
        latency_ms: Date.now() - started,
        error_code: liveGate.error ?? "LIVE_DELIVERY_DISABLED",
      });
    }

    if (!resolveZapiHttpConfig()) {
      return buildProviderHealthResult({
        provider: this.providerName,
        ok: false,
        latency_ms: Date.now() - started,
        error_code: "ZAPI_NOT_CONFIGURED",
      });
    }

    let result = await zapiFetch("/status", { method: "GET" });
    if (!result.ok && result.error_code === "INVALID_PAYLOAD") {
      result = await zapiFetch("/status-connection", { method: "GET" });
    }

    const data =
      result.data && typeof result.data === "object"
        ? /** @type {{ connected?: boolean; smartphoneConnected?: boolean; error?: string }} */ (
            result.data
          )
        : null;

    const connected =
      data != null &&
      (data.connected === true ||
        (typeof data.smartphoneConnected === "boolean" && data.smartphoneConnected === true));

    const instanceMissing = result.error_code === "ZAPI_INSTANCE_NOT_FOUND";

    return buildProviderHealthResult({
      provider: this.providerName,
      ok: connected && !instanceMissing,
      latency_ms: result.duration_ms,
      error_code:
        connected && !instanceMissing
          ? null
          : instanceMissing
            ? "ZAPI_INSTANCE_NOT_FOUND"
            : result.error_code ?? "PROVIDER_UNAVAILABLE",
      metadata: {
        http_status: result.http_status,
        smartphone_connected: data?.smartphoneConnected,
        zapi_error: data?.error ?? null,
      },
    });
  }

  /** @param {import("../../abstraction/ProviderAdapter.js").ProviderSendInput} input */
  async send(input) {
    const validation = await this.validate(input);
    if (!validation.ok) {
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: validation.error ?? "INVALID_PHONE",
      });
    }

    const dispatchId = input.dispatch_id ?? input.metadata?.dispatch_id ?? null;
    const attempt = Number(input.attempt ?? input.metadata?.attempt ?? 1) || 1;
    const sellerId =
      input.metadata?.seller_id != null ? String(input.metadata.seller_id) : null;

    const liveGate = assertWhatsAppLiveDeliveryEnabled();
    if (!liveGate.ok) {
      logProviderBlocked({
        provider_name: this.providerName,
        delivery_mode: S7_DELIVERY_MODE.LIVE,
        dispatch_id: dispatchId,
        attempt,
        error_code: liveGate.error ?? "LIVE_DELIVERY_DISABLED",
        to: String(input.to ?? ""),
      });
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: liveGate.error ?? "LIVE_DELIVERY_DISABLED",
        blocked: true,
      });
    }

    const rowMetadata =
      input.metadata && typeof input.metadata === "object"
        ? /** @type {Record<string, unknown>} */ (input.metadata)
        : {};

    const smokeGate = resolveZapiProviderSmokeGate({
      sellerId,
      phone: input.to,
      metadata: rowMetadata,
    });

    if (!smokeGate.allowed) {
      logProviderBlocked({
        provider_name: this.providerName,
        delivery_mode: S7_DELIVERY_MODE.LIVE,
        dispatch_id: dispatchId,
        attempt,
        error_code: smokeGate.reason ?? "BLOCKED_BY_SMOKE_POLICY",
        to: String(input.to ?? ""),
        provider_smoke_policy_applied: smokeGate.provider_smoke_policy_applied,
        provider_live_bypass_respected: smokeGate.provider_live_bypass_respected,
        provider_final_send_allowed: false,
        zapi_request_called: false,
      });
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: smokeGate.reason ?? "BLOCKED_BY_SMOKE_POLICY",
        blocked: true,
      });
    }

    logProviderStart({
      provider_name: this.providerName,
      delivery_mode: S7_DELIVERY_MODE.LIVE,
      dispatch_id: dispatchId,
      attempt,
      to: String(input.to ?? ""),
      provider_smoke_policy_applied: smokeGate.provider_smoke_policy_applied,
      provider_live_bypass_respected: smokeGate.provider_live_bypass_respected,
      provider_final_send_allowed: smokeGate.provider_final_send_allowed,
      zapi_request_called: true,
    });

    const phone = String(input.to ?? "").replace(/\D/g, "");
    const deliveryFormat =
      rowMetadata.delivery_format != null ? String(rowMetadata.delivery_format) : "text";
    const shareImageDataUri =
      rowMetadata.share_image_data_uri != null ? String(rowMetadata.share_image_data_uri) : "";
    const caption = String(input.message ?? "");

    const sendImage = deliveryFormat === "image" && shareImageDataUri.length > 0;

    let result;
    if (sendImage) {
      result = await zapiFetch("/send-image", {
        method: "POST",
        body: {
          phone,
          image: shareImageDataUri,
          caption,
          viewOnce: false,
        },
      });
      if (!result.ok && result.http_status === 404) {
        result = await zapiFetch("/message/send-image", {
          method: "POST",
          body: {
            phone,
            image: shareImageDataUri,
            caption,
            viewOnce: false,
          },
        });
      }
    } else {
      result = await zapiFetch("/send-text", {
        method: "POST",
        body: { phone, message: caption },
      });
      if (!result.ok && result.http_status === 404) {
        result = await zapiFetch("/message/send-text", {
          method: "POST",
          body: { phone, message: caption },
        });
      }
    }

    if (!result.ok) {
      logProviderFail({
        provider_name: this.providerName,
        delivery_mode: S7_DELIVERY_MODE.LIVE,
        dispatch_id: dispatchId,
        attempt,
        duration_ms: result.duration_ms,
        http_status: result.http_status,
        error_code: result.error_code ?? "PROVIDER_ERROR",
        to: phone,
      });
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: result.error_code ?? "PROVIDER_ERROR",
        metadata: { http_status: result.http_status },
      });
    }

    const shareDocumentDataUri =
      rowMetadata.share_document_data_uri != null
        ? String(rowMetadata.share_document_data_uri)
        : "";
    const shareDocumentFilename =
      rowMetadata.share_document_filename != null
        ? String(rowMetadata.share_document_filename)
        : "relatorio.xlsx";

    if (shareDocumentDataUri.length > 0) {
      const ext = shareDocumentFilename.includes(".")
        ? shareDocumentFilename.split(".").pop()
        : "xlsx";
      let docResult = await zapiFetch(`/send-document/${ext}`, {
        method: "POST",
        body: {
          phone,
          document: shareDocumentDataUri,
          fileName: shareDocumentFilename,
        },
      });
      if (!docResult.ok && docResult.http_status === 404) {
        docResult = await zapiFetch("/send-document", {
          method: "POST",
          body: {
            phone,
            document: shareDocumentDataUri,
            fileName: shareDocumentFilename,
          },
        });
      }
      if (!docResult.ok) {
        logProviderFail({
          provider_name: this.providerName,
          delivery_mode: S7_DELIVERY_MODE.LIVE,
          dispatch_id: dispatchId,
          attempt,
          duration_ms: docResult.duration_ms,
          http_status: docResult.http_status,
          error_code: docResult.error_code ?? "DOCUMENT_SEND_FAILED",
          to: phone,
        });
      }
    }

    const data = result.data && typeof result.data === "object" ? result.data : {};
    const providerMessageId = String(
      /** @type {{ messageId?: string; id?: string; zaapId?: string }} */ (data).messageId ??
        /** @type {{ id?: string }} */ (data).id ??
        /** @type {{ zaapId?: string }} */ (data).zaapId ??
        ""
    );

    logProviderSuccess({
      provider_name: this.providerName,
      delivery_mode: S7_DELIVERY_MODE.LIVE,
      dispatch_id: dispatchId,
      attempt,
      duration_ms: result.duration_ms,
      http_status: result.http_status,
      provider_message_id: providerMessageId || null,
      to: phone,
      provider_smoke_policy_applied: smokeGate.provider_smoke_policy_applied,
      provider_live_bypass_respected: smokeGate.provider_live_bypass_respected,
      provider_final_send_allowed: true,
      zapi_request_called: true,
    });

    return toProviderResponse({
      ok: true,
      simulated: false,
      provider: this.providerName,
      providerMessageId: providerMessageId || `zapi_${Date.now()}`,
      metadata: {
        http_status: result.http_status,
        delivery_mode: S7_DELIVERY_MODE.LIVE,
      },
      raw: /** @type {Record<string, unknown>} */ (data),
    });
  }
}
