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
import { evaluateProviderSmokePolicy } from "../../abstraction/providerSmokePolicy.js";
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

    const result = await zapiFetch("/status", { method: "GET" });
    const connected =
      result.ok &&
      result.data &&
      typeof result.data === "object" &&
      /** @type {{ connected?: boolean }} */ (result.data).connected === true;

    return buildProviderHealthResult({
      provider: this.providerName,
      ok: connected,
      latency_ms: result.duration_ms,
      error_code: connected ? null : result.error_code ?? "PROVIDER_UNAVAILABLE",
      metadata: {
        http_status: result.http_status,
        smartphone_connected:
          result.data && typeof result.data === "object"
            ? /** @type {{ smartphoneConnected?: boolean }} */ (result.data).smartphoneConnected
            : undefined,
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

    const smoke = evaluateProviderSmokePolicy({ sellerId, phone: input.to });
    if (!smoke.allowed) {
      logProviderBlocked({
        provider_name: this.providerName,
        delivery_mode: S7_DELIVERY_MODE.LIVE,
        dispatch_id: dispatchId,
        attempt,
        error_code: smoke.reason ?? "BLOCKED_BY_SMOKE_POLICY",
        to: String(input.to ?? ""),
      });
      return toProviderResponse({
        ok: false,
        provider: this.providerName,
        error: smoke.reason ?? "BLOCKED_BY_SMOKE_POLICY",
        blocked: true,
      });
    }

    logProviderStart({
      provider_name: this.providerName,
      delivery_mode: S7_DELIVERY_MODE.LIVE,
      dispatch_id: dispatchId,
      attempt,
      to: String(input.to ?? ""),
    });

    const phone = String(input.to ?? "").replace(/\D/g, "");
    const result = await zapiFetch("/send-text", {
      method: "POST",
      body: { phone, message: String(input.message ?? "") },
    });

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
