// ======================================================================
// AsaasBillingProvider — REST v3 (sandbox/produção via ASAAS_API_BASE_URL)
// ======================================================================

import { config } from "../../infra/config.js";
import { BillingProvider } from "./BillingProvider.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { normalizeAsaasApiBaseUrl, summarizeAsaasErrorBody } from "./asaasApiHelpers.js";

export class AsaasApiError extends Error {
  /**
   * @param {number} status
   * @param {unknown} body
   */
  constructor(status, body) {
    super(`Asaas HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class AsaasBillingProvider extends BillingProvider {
  constructor() {
    super("asaas");
    this.baseUrl = normalizeAsaasApiBaseUrl(config.asaasApiBaseUrl, config.asaasEnv);
    this.apiKey = config.asaasApiKey;
    this.env = config.asaasEnv;
  }

  assertConfigured() {
    if (!String(this.baseUrl || "").trim()) {
      const e = new Error("Defina ASAAS_API_BASE_URL (ex.: https://api-sandbox.asaas.com/v3).");
      /** @type {any} */ (e).code = "ASAAS_BASE_URL_REQUIRED";
      throw e;
    }
    if (!String(this.apiKey || "").trim()) {
      const e = new Error("Defina ASAAS_API_KEY no ambiente do backend.");
      /** @type {any} */ (e).code = "ASAAS_API_KEY_REQUIRED";
      throw e;
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {Record<string, unknown> | undefined} body
   */
  async request(method, path, body) {
    this.assertConfigured();
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    logBilling("asaas", "request", { method, path: path.split("?")[0], env: this.env });

    const headers = {
      access_token: this.apiKey,
    };
    if (body != null && method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body != null && method !== "GET" && method !== "HEAD" ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    /** @type {unknown} */
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }

    if (!res.ok) {
      const summary = summarizeAsaasErrorBody(json);
      logBillingError("asaas", "request_failed", new AsaasApiError(res.status, json), {
        status: res.status,
        path: path.split("?")[0],
        error_code: summary.errors[0]?.code ?? null,
        error_message: summary.message,
      });
      throw new AsaasApiError(res.status, json);
    }

    return json;
  }

  /** @param {{ name: string; email: string; externalReference?: string; cpfCnpj?: string; notificationDisabled?: boolean }} input */
  async createCustomer(input) {
    const payload = {
      name: input.name,
      email: input.email,
      notificationDisabled: input.notificationDisabled !== false,
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}),
    };
    return this.request("POST", "/customers", payload);
  }

  /**
   * @param {string} providerCustomerId
   * @param {{ notificationDisabled?: boolean; name?: string; email?: string }} input
   */
  async updateCustomer(providerCustomerId, input) {
    return this.request("PUT", `/customers/${encodeURIComponent(providerCustomerId)}`, input);
  }

  /**
   * @param {{
   *   customer: string;
   *   billingType: string;
   *   value: string;
   *   nextDueDate: string;
   *   cycle: string;
   *   description?: string;
   *   externalReference?: string;
   * }} input
   */
  async createSubscription(input) {
    return this.request("POST", "/subscriptions", { ...input });
  }

  /** @param {string} providerSubscriptionId */
  async cancelSubscription(providerSubscriptionId) {
    return this.request("DELETE", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, undefined);
  }

  /** @param {string} providerSubscriptionId */
  async getSubscription(providerSubscriptionId) {
    return this.request("GET", `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, undefined);
  }

  /**
   * @param {string} providerSubscriptionId
   * @param {{ limit?: number }} [options]
   */
  async listSubscriptionPayments(providerSubscriptionId, options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 1;
    return this.request(
      "GET",
      `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/payments?limit=${limit}`,
      undefined
    );
  }

  /** @param {Record<string, unknown>} input */
  async createPayment(input) {
    return this.request("POST", "/payments", input);
  }

  /** @param {string} providerPaymentId */
  async getPayment(providerPaymentId) {
    return this.request("GET", `/payments/${encodeURIComponent(providerPaymentId)}`, undefined);
  }

  /** Cancela/remove cobrança pendente no Asaas (sandbox/dev). */
  async cancelPayment(providerPaymentId) {
    return this.request("DELETE", `/payments/${encodeURIComponent(providerPaymentId)}`, undefined);
  }

  /** @param {string} providerPaymentId */
  async getPaymentPixQrCode(providerPaymentId) {
    return this.request("GET", `/payments/${encodeURIComponent(providerPaymentId)}/pixQrCode`, undefined);
  }

  /** @param {string} providerPaymentId */
  async getPaymentIdentificationField(providerPaymentId) {
    return this.request(
      "GET",
      `/payments/${encodeURIComponent(providerPaymentId)}/identificationField`,
      undefined
    );
  }

  /** @param {Record<string, unknown>} input */
  async tokenizeCreditCard(input) {
    return this.request("POST", "/creditCard/tokenizeCreditCard", input);
  }
}
