#!/usr/bin/env node
/**
 * Profile summary logo — schema-tolerant loader + runtime DEV probe
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { carregarLogoUrlEmpresaPrincipal } from "../src/domain/seller/carregarLogoUrlEmpresaPrincipal.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const loaderSrc = fs.readFileSync(
  path.join(backendRoot, "src/domain/seller/carregarLogoUrlEmpresaPrincipal.js"),
  "utf8",
);
const profileSrc = fs.readFileSync(
  path.join(backendRoot, "src/handlers/user/profileSummary.js"),
  "utf8",
);

assert("loader avoids avatar_url column", !loaderSrc.includes("avatar_url"));
assert("profile-summary uses loader", profileSrc.includes("carregarLogoUrlEmpresaPrincipal"));
assert("profile-summary no avatar_url select", !profileSrc.includes("avatar_url"));

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: mlAccounts } = await supabase
    .from("marketplace_accounts")
    .select("user_id")
    .eq("marketplace", "mercado_livre")
    .eq("status", "active")
    .limit(1);
  const userId = mlAccounts?.[0]?.user_id;
  if (userId) {
    const logo = await carregarLogoUrlEmpresaPrincipal(supabase, userId);
    assert("runtime DEV logo loader returns value for active ML seller", Boolean(logo));
  }
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "profile_summary_logo_runtime_unit", cases: 4 }, null, 2));
