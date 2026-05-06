/**
 * @param {import("http").IncomingMessage & { bodyBuffer?: Buffer; body?: unknown }} req
 * @returns {Promise<Buffer>}
 */
export async function readRequestBodyBuffer(req) {
  if (Buffer.isBuffer(req.bodyBuffer)) return req.bodyBuffer;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body != null && typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body != null && typeof req.body === "object") {
    try {
      return Buffer.from(JSON.stringify(req.body), "utf8");
    } catch {
      return Buffer.from("", "utf8");
    }
  }

  return await new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

