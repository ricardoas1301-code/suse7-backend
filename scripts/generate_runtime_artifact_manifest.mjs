#!/usr/bin/env node
/**
 * Gera manifesto determinístico do artefato runtime (backend).
 * Uso: node scripts/generate_runtime_artifact_manifest.mjs [--out path]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} dir */
function walkFiles(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "output" || ent.name === ".temp") continue;
      out.push(...walkFiles(full, base));
    } else {
      out.push(path.relative(base, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

function sha256File(absPath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(absPath));
  return hash.digest("hex");
}

function git(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", shell: true }).trim();
  } catch {
    return null;
  }
}

function main() {
  const scopes = ["api", "src"];
  const extra = ["package.json", "package-lock.json", "vercel.json"].filter((f) =>
    fs.existsSync(path.join(root, f)),
  );

  /** @type {{ path: string; size: number; sha256: string }[]} */
  const files = [];

  for (const scope of scopes) {
    const absScope = path.join(root, scope);
    for (const rel of walkFiles(absScope, absScope).sort()) {
      const abs = path.join(absScope, rel);
      const relPath = `${scope}/${rel}`;
      files.push({ path: relPath, size: fs.statSync(abs).size, sha256: sha256File(abs) });
    }
  }

  for (const rel of extra) {
    const abs = path.join(root, rel);
    files.push({ path: rel, size: fs.statSync(abs).size, sha256: sha256File(abs) });
  }

  const lockHash = fs.existsSync(path.join(root, "package-lock.json"))
    ? sha256File(path.join(root, "package-lock.json"))
    : null;

  const manifestCore = files.map((f) => `${f.path}\t${f.sha256}\t${f.size}`).join("\n");
  const manifestId = crypto.createHash("sha256").update(manifestCore).digest("hex");

  const manifest = {
    generated_at: new Date().toISOString(),
    project: "suse7-backend",
    git_sha: git("git rev-parse HEAD"),
    git_tree: git('git rev-parse "HEAD^{tree}"'),
    branch: git("git branch --show-current"),
    node_version: process.version,
    package_lock_sha256: lockHash,
    manifest_id: manifestId,
    file_count: files.length,
    files,
  };

  const outArgIdx = process.argv.indexOf("--out");
  const outPath =
    outArgIdx >= 0
      ? process.argv[outArgIdx + 1]
      : path.join(root, "scripts/output/runtime-artifact-manifest-backend.json");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[generate_runtime_artifact_manifest] files=${files.length} manifest_id=${manifestId.slice(0, 12)}…`);
  console.log(outPath);
}

main();
