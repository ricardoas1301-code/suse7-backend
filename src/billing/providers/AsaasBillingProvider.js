// ======================================================================
// AsaasBillingProvider — REST v3 (sandbox/produção via ASAAS_API_BASE_URL)
// ======================================================================

import { config } from "../../infra/config.js";
import { BillingProvider } from "./BillingProvider.js";
import { logBilling, logBillingError } from "../billingLog.js";

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
    this.baseUrl = config.asaasApiBaseUrl.replace(/\/+$/, "");
    this.apiKey = config.asaasApiKey;
    this.env = config.asaasEnv;
  }

  assertConfigured() {
    if (!String(this.baseUrl || "").trim()) {
      const e = new Error("Defina ASAAS_API_BASE_URL (ex.: https://sandbox.asaas.com/api/v3).");
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
      Authorization: `Bearer ${this.apiKey}`,
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
      logBillingError("asaas", "request_failed", new AsaasApiError(res.status, json), { status: res.status });
      throw new AsaasApiError(res.status, json);
    }

    return json;
  }

  /** @param {{ name: string; email: string; externalReference?: string; cpfCnpj?: string }} input */
  async createCustomer(input) {
    const payload = {
      name: input.name,
      email: input.email,
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}),
    };
    return this.request("POST", "/customers", payload);
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

  /** @param {Record<string, unknown>} input */
  async createPayment(input) {
    return this.request("POST", "/payments", input);
  }

  /** @param {string} providerPaymentId */
  async getPayment(providerPaymentId) {
    return this.request("GET", `/payments/${encodeURIComponent(providerPaymentId)}`, undefined);
  }
}
