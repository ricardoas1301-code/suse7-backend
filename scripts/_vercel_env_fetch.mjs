#!/usr/bin/env node
/**
 * Fetch Vercel env value by name — never logs value.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readVercelToken() {
  const authPath = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "com.vercel.cli",
    "Data",
    "auth.json",
  );
  const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const token = raw.token || raw.credentials?.[0]?.token;
  if (!token) throw new Error("Vercel token unavailable");
  return token;
}

/**
 * @param {string} projectId
 * @param {string} name
 * @param {"production"|"preview"|"development"} target
 */
export async function fetchVercelEnvValue(projectId, name, target = "production") {
  const token = readVercelToken();
  const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env?decrypt=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Vercel env list failed ${res.status}`);
  const data = await res.json();
  const entries = data.envs || data;
  for (const entry of entries) {
    if (entry.key !== name) continue;
    const targets = entry.target || [];
    if (!targets.includes(target) && !targets.includes("production")) continue;
    const val = entry.value ?? entry.decryptedValue ?? "";
    if (String(val).trim()) return String(val).trim();
  }
  throw new Error(`Vercel env ${name} missing for ${target} on project ${projectId}`);
}

export const VERCEL_DEV_PROJECT_ID = "prj_TvAjlZFVkLOrgxW7bgGD5VIX7LK3";
export const VERCEL_PROD_PROJECT_ID = "prj_82lxqfRgGm33UeWMWvrQt9qe5EwZ";
