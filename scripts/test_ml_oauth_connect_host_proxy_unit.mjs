#!/usr/bin/env node
/**
 * Backend — host proxy /api/ml/connect (DEV localhost → callback Vercel).
 */
import { resolveMlOAuthConnectHostProxy, buildMlOAuthConnectProxyUrl } from "../src/handlers/ml/_helpers/oauthConnect.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const redirectUri = "https://suse7-backend-dev.vercel.app/api/ml/callback";
const localReq = { headers: { host: "localhost:3001" }, query: { seller_company_id: "a1b2c3d4-e5f6-4789-a012-3456789abcde" } };

const proxy = resolveMlOAuthConnectHostProxy(localReq, redirectUri);
assert("localhost connect vs vercel callback triggers proxy", proxy.shouldProxy === true);
assert("proxy reason is host mismatch", proxy.reason === "connect_callback_host_mismatch");
assert("proxy target is vercel backend base", proxy.targetConnectUrl === "https://suse7-backend-dev.vercel.app");

const proxyUrl = buildMlOAuthConnectProxyUrl(proxy.targetConnectUrl, localReq);
assert("proxy URL preserves seller_company_id", proxyUrl.includes("seller_company_id=a1b2c3d4-e5f6-4789-a012-3456789abcde"));
assert("proxy URL targets /api/ml/connect on vercel", proxyUrl.startsWith("https://suse7-backend-dev.vercel.app/api/ml/connect"));

const sameHostReq = { headers: { host: "suse7-backend-dev.vercel.app" } };
const noProxy = resolveMlOAuthConnectHostProxy(sameHostReq, redirectUri);
assert("same host connect and callback skips proxy", noProxy.shouldProxy === false);

if (failures.length) {
  console.error("[ML OAuth connect host proxy unit] FAIL", failures);
  process.exit(1);
}

console.log("[ML OAuth connect host proxy unit] OK");
