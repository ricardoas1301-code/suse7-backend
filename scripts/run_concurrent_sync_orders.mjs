#!/usr/bin/env node
/** 10× sync paralelo via child_process — pipeline real sync_ml_orders_by_id.mjs */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const orderId = process.argv[2];
const runs = Number(process.argv[3] ?? 10);
if (!orderId) {
  console.error("Uso: node scripts/run_concurrent_sync_orders.mjs <order_id> [runs]");
  process.exit(1);
}

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "sync_ml_orders_by_id.mjs");
const started = new Date().toISOString();

function runOne(i) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script, orderId], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      resolve({ run: i, code, ms: Date.now() - t0, out_tail: out.slice(-800), err_tail: err.slice(-400) });
    });
  });
}

const results = await Promise.all(Array.from({ length: runs }, (_, i) => runOne(i + 1)));
console.log(JSON.stringify({ orderId, runs, started_at_utc: started, finished_at_utc: new Date().toISOString(), results }, null, 2));
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
