// ======================================================================
// BillingProvider — interface para gateways (Asaas, Stripe, Mercado Pago, …)
// ======================================================================

/**
 * @typedef {Record<string, unknown>} JsonObject
 */

export class BillingProvider {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  assertConfigured() {
    /* gateway opcional em testes */
  }

  /** @param {{ name: string; email: string; externalReference?: string; cpfCnpj?: string }} input */
  async createCustomer(input) {
    void input;
    throw new Error(`createCustomer not implemented for ${this.name}`);
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
    void input;
    throw new Error(`createSubscription not implemented for ${this.name}`);
  }

  /** @param {string} providerSubscriptionId */
  async cancelSubscription(providerSubscriptionId) {
    void providerSubscriptionId;
    throw new Error(`cancelSubscription not implemented for ${this.name}`);
  }

  /** @param {string} providerSubscriptionId */
  async getSubscription(providerSubscriptionId) {
    void providerSubscriptionId;
    throw new Error(`getSubscription not implemented for ${this.name}`);
  }

  /** @param {JsonObject} input */
  async createPayment(input) {
    void input;
    throw new Error(`createPayment not implemented for ${this.name}`);
  }

  /** @param {string} providerPaymentId */
  async getPayment(providerPaymentId) {
    void providerPaymentId;
    throw new Error(`getPayment not implemented for ${this.name}`);
  }
}
