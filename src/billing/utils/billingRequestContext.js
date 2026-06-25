// ======================================================================

// Contexto HTTP — billing (IP do cliente, etc.)

// ======================================================================



/**

 * @param {import("http").IncomingMessage} req

 */

export function resolveClientRemoteIp(req) {

  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim() !== "") {

    return forwarded.split(",")[0].trim();

  }

  if (Array.isArray(forwarded) && forwarded[0]) {

    return String(forwarded[0]).trim();

  }

  const realIp = req.headers["x-real-ip"];

  if (typeof realIp === "string" && realIp.trim() !== "") {

    return realIp.trim();

  }

  const socketIp = req.socket?.remoteAddress;

  if (typeof socketIp === "string" && socketIp.trim() !== "") {

    return socketIp.replace(/^::ffff:/, "").trim();

  }

  return "127.0.0.1";

}



/**

 * @param {Record<string, unknown>} body

 */

export function resolveCardCheckoutPaymentMethod(body) {

  const pm = typeof body.payment_method === "string" ? body.payment_method.trim().toUpperCase() : "";

  if (pm === "CREDIT_CARD" || pm === "CREDIT") return "CREDIT_CARD";

  return "CREDIT_CARD";

}



/**

 * @param {Record<string, unknown>} body

 */

export function buildCardCheckoutFromRequestBody(body) {

  const card =

    body.card && typeof body.card === "object" ? /** @type {Record<string, unknown>} */ (body.card) : null;



  return {

    remoteIp: "",

    card_type: "credit",

    payment_method_id:

      typeof body.payment_method_id === "string" ? body.payment_method_id.trim() : null,

    card,

    cpf_cnpj: typeof body.cpf_cnpj === "string" ? body.cpf_cnpj.trim() : null,

    postal_code: typeof body.postal_code === "string" ? body.postal_code.trim() : null,

    address_number: typeof body.address_number === "string" ? body.address_number.trim() : null,

    phone: typeof body.phone === "string" ? body.phone.trim() : null,

    set_default: body.set_default !== false,

    persist: body.persist !== false,

  };

}



/** @deprecated Checkout aceita apenas crédito no MVP. */

export function normalizeCardType(_value) {

  return "credit";

}


