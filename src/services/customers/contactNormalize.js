/** @param {unknown} v */
function strTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** @param {unknown} v */
export function digitsOnly(v) {
  const s = strTrim(v);
  if (!s) return "";
  return s.replace(/\D+/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * E-mail: trim, lowercase, validação básica (RFC completa não é objetivo aqui).
 * @param {unknown} email
 * @returns {string | null}
 */
export function normalizeEmail(email) {
  const s = strTrim(email).toLowerCase();
  if (!s) return null;
  if (emailLooksMasked(s)) return s;
  if (!EMAIL_RE.test(s)) return null;
  return s;
}

/**
 * Heurística para e-mail mascarado (ex.: ab***@..., ***@...).
 * @param {unknown} email
 */
export function emailLooksMasked(email) {
  const s = strTrim(email);
  if (!s) return false;
  if (/\*+/.test(s)) return true;
  if (/\.{3,}/.test(s)) return true;
  if (/\bx{3,}\b/i.test(s)) return true;
  return false;
}

/** Formato nacional BR para exibição (DDD + número). */
function formatBrNational(digits) {
  const d = digitsOnly(digits);
  if (!d) return null;
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return d;
}

/**
 * Telefone BR a partir de area_code + number (+ extension só metadata).
 * @param {{ area_code?: unknown; number?: unknown; extension?: unknown } | null | undefined} parts
 */
export function normalizeBrazilPhone(parts) {
  if (!parts || typeof parts !== "object") {
    return {
      national_digits: null,
      display: null,
      area_code: null,
      number: null,
      extension: null,
    };
  }
  const ac = digitsOnly(parts.area_code);
  const num = digitsOnly(parts.number);
  const ext = digitsOnly(parts.extension);
  if (!num) {
    return {
      national_digits: null,
      display: null,
      area_code: ac || null,
      number: null,
      extension: ext || null,
    };
  }
  const national = ac ? `${ac}${num}` : num;
  return {
    national_digits: national,
    display: formatBrNational(national),
    area_code: ac || null,
    number: num,
    extension: ext || null,
  };
}

/**
 * Parse telefone a partir de string (receiver_phone, colunas importadas).
 * @param {unknown} str
 */
export function normalizeBrazilPhoneFromString(str) {
  let d = digitsOnly(str);
  if (!d) {
    return {
      national_digits: null,
      display: null,
      area_code: null,
      number: null,
      extension: null,
    };
  }
  if (d.startsWith("55") && d.length >= 12) {
    d = d.slice(2);
  }
  if (d.length >= 10 && d.length <= 11) {
    const ac = d.slice(0, 2);
    const num = d.slice(2);
    return normalizeBrazilPhone({ area_code: ac, number: num, extension: null });
  }
  return {
    national_digits: d,
    display: formatBrNational(d),
    area_code: null,
    number: d,
    extension: null,
  };
}

/**
 * WhatsApp E.164 BR quando possível (+55 + DDD + número).
 * @param {unknown} nationalDigits — apenas dígitos nacionais (sem 55) ou já com 55
 */
export function buildWhatsappE164(nationalDigits) {
  let d = digitsOnly(nationalDigits);
  if (!d) return null;
  if (d.startsWith("55")) {
    return d.length >= 12 ? `+${d}` : null;
  }
  if (d.length >= 10 && d.length <= 11) {
    return `+55${d}`;
  }
  return null;
}
