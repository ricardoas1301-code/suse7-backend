#!/usr/bin/env node
/**
 * P0.2-N.2 — worker deve permanecer UTF-8 no git (UTF-16 quebra import no Vercel).
 */
import { execSync } from "node:child_process";

const path = "src/services/marketplace/marketplaceAccountSyncWorker.js";
const rev = process.argv[2] || "HEAD";
const buf = execSync(`git cat-file -p ${rev}:${path}`);

const isUtf16Le = buf.length >= 4 && buf[0] === 0x2f && buf[1] === 0x00 && buf[2] === 0x2f && buf[3] === 0x00;
const isUtf8 = buf.length >= 2 && buf[0] === 0x2f && buf[1] === 0x2f;

if (isUtf16Le || !isUtf8) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        test: "worker_git_blob_encoding",
        rev,
        bytes: buf.length,
        head: [...buf.slice(0, 8)],
        reason: isUtf16Le ? "utf16_le_detected" : "not_utf8_ascii",
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, test: "worker_git_blob_encoding", rev, bytes: buf.length }, null, 2));
