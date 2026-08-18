import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stagedPath = path.join(__dirname, "../.s7-staging/api-index-23c.staged");
const head = execSync("git show HEAD:api/index.js", { cwd: path.join(__dirname, ".."), encoding: "utf8" });
const next = head.replace(
  'console.log("[S7 API Router] boot — legal: GET /api/legal/documents/terms-of-use · POST /api/legal/document-acceptances");',
  'console.log("[S7 API Router] boot — legal: GET /api/legal/documents · GET /api/legal/documents/terms-of-use · GET /api/legal/documents/privacy-policy · POST /api/legal/document-acceptances");',
);
fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
fs.writeFileSync(stagedPath, next, "utf8");
console.log("wrote", stagedPath);
