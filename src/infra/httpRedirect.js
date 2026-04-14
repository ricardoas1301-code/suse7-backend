// ======================================================
// Redirect HTTP portável — Vercel (ServerResponse), dev-server
// compat (createRes) e helpers estilo Express quando existirem.
// Não usar res.status(302).redirect() sem garantir .redirect no chain.
// ======================================================

/**
 * @param {import("http").ServerResponse | Record<string, unknown>} res
 * @param {string} location URL absoluta
 * @param {number} [statusCode=302]
 */
export function sendRedirect(res, location, statusCode = 302) {
  const loc = String(location ?? "").trim();
  if (!loc) {
    if (typeof res.status === "function") {
      const chain = res.status(500);
      if (chain && typeof chain.json === "function") {
        return chain.json({ ok: false, error: "Invalid redirect location" });
      }
    }
    return;
  }

  if (typeof res.redirect === "function") {
    try {
      if (res.redirect.length >= 2) {
        return res.redirect(statusCode, loc);
      }
      if (typeof res.status === "function") {
        res.status(statusCode);
      } else {
        res.statusCode = statusCode;
      }
      return res.redirect(loc);
    } catch {
      /* cair para setHeader + end */
    }
  }

  res.statusCode = statusCode;
  if (typeof res.setHeader === "function") {
    res.setHeader("Location", loc);
  }
  if (typeof res.end === "function") {
    return res.end();
  }
}
