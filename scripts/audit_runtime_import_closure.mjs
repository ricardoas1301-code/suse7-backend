#!/usr/bin/env node
/**
 * Audita closure de imports runtime do backend SUSE7.
 * Falha (exit 1) se MISSING_RUNTIME_IMPORTS > 0.
 *
 * Uso: node scripts/audit_runtime_import_closure.mjs [--json-out path]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {string[]} */
const ENTRYPOINTS = [
  "api/index.js",
  "src/dev-server.js",
];

/** @type {string[]} */
const SCAN_ROOTS = ["api", "src"];

const IMPORT_RE =
  /\b(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+|)\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** @param {string} p */
function isExternal(spec) {
  return !spec.startsWith(".") && !spec.startsWith("/");
}

/**
 * @param {string} fromFile
 * @param {string} spec
 */
function resolveLocalImport(fromFile, spec) {
  const baseDir = path.dirname(fromFile);
  let candidate = path.normalize(path.join(baseDir, spec));
  const candidates = [
    candidate,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    path.join(candidate, "index.js"),
    path.join(candidate, "index.mjs"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** @param {string} filePath */
function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/** @param {string} line */
function isCommentOrJsDocTypeImport(line) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return true;
  if (t.includes("@type") && t.includes("import(")) return true;
  return false;
}

/** @param {string} filePath */
function collectSpecsFromFile(filePath) {
  const rel = path.relative(root, filePath).replace(/\\/g, "/");
  const text = readText(filePath);
  /** @type {{ spec: string; kind: string; line: number }[]} */
  const specs = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOrJsDocTypeImport(line)) continue;
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        specs.push({ spec: m[1], kind: re === DYNAMIC_IMPORT_RE ? "dynamic" : "static", line: i + 1 });
      }
    }
  }
  return { rel, specs };
}

/** Rotas do gate CPJ-0000B (superfície homologada). */
const CRITICAL_ROUTES = new Set([
  "/api/health",
  "/api/sales",
  "/api/sales/top10",
  "/api/sales/executive-summary",
  "/api/sales/detail",
  "/api/sales/summary",
  "/api/ml/oauth-config",
  "/api/billing/ping",
  "/api/billing/plans",
  "/api/products/health",
  "/api/listings/bulk-set-sku",
]);

/** @param {string} dir */
function walkJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "output") continue;
      out.push(...walkJsFiles(full));
    } else if (/\.(js|mjs|cjs)$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Rotas dinâmicas declaradas em api/index.js */
function auditApiRouteHandlers() {
  const apiIndex = path.join(root, "api/index.js");
  const text = readText(apiIndex);
  /** @type {{ route: string; target: string; resolved: string | null }[]} */
  const routes = [];
  const routeRe =
    /if\s*\(\s*path\s*===\s*["']([^"']+)["'][^)]*\)\s*\{[\s\S]*?import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = routeRe.exec(text)) !== null) {
    const target = m[2];
    const absFromApi = path.join(root, "api/index.js");
    const resolved = resolveLocalImport(absFromApi, target);
    routes.push({ route: m[1], target, resolved });
  }
  return routes;
}

/** @type {Set<string>} */
const visited = new Set();
/** @type {{ consumer: string; spec: string; kind: string; line: number; resolved: string | null }[]} */
const missing = [];

/**
 * @param {string} absFile
 * @param {string} consumerRel
 * @param {string} spec
 * @param {string} kind
 * @param {number} line
 */
function visitImport(absFile, consumerRel, spec, kind, line) {
  if (isExternal(spec)) return;
  const resolved = resolveLocalImport(absFile, spec);
  if (!resolved) {
    missing.push({ consumer: consumerRel, spec, kind, line, resolved: null });
    return;
  }
  const rel = path.relative(root, resolved).replace(/\\/g, "/");
  if (visited.has(rel)) return;
  visited.add(rel);
  const { specs } = collectSpecsFromFile(resolved);
  for (const s of specs) {
    visitImport(resolved, rel, s.spec, s.kind, s.line);
  }
}

function main() {
  /** @type {string[]} */
  const scannedFiles = [];

  for (const ep of ENTRYPOINTS) {
    const abs = path.join(root, ep);
    if (!fs.existsSync(abs)) {
      missing.push({ consumer: ep, spec: ep, kind: "entrypoint", line: 0, resolved: null });
      continue;
    }
    const rel = ep;
    visited.add(rel);
    scannedFiles.push(rel);
    const { specs } = collectSpecsFromFile(abs);
    for (const s of specs) {
      visitImport(abs, rel, s.spec, s.kind, s.line);
    }
  }

  for (const dir of SCAN_ROOTS) {
    for (const abs of walkJsFiles(path.join(root, dir))) {
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (!visited.has(rel)) continue;
      scannedFiles.push(rel);
    }
  }

  const routeHandlers = auditApiRouteHandlers();
  for (const r of routeHandlers) {
    if (!r.resolved) {
      missing.push({
        consumer: "api/index.js",
        spec: r.target,
        kind: `route:${r.route}`,
        line: 0,
        resolved: null,
      });
    }
  }

  const missingCritical = missing.filter((m) => {
    if (m.kind.startsWith("route:")) {
      return CRITICAL_ROUTES.has(m.kind.slice("route:".length));
    }
    if (m.consumer === "api/index.js") {
      return routeHandlers.some(
        (r) => CRITICAL_ROUTES.has(r.route) && r.target === m.spec && !r.resolved,
      );
    }
    return false;
  });

  const report = {
    generated_at: new Date().toISOString(),
    git_sha: process.env.GIT_SHA || null,
    entrypoints: ENTRYPOINTS,
    files_in_closure: [...visited].sort(),
    files_scanned_count: visited.size,
    route_handlers: routeHandlers.map((r) => ({
      route: r.route,
      target: r.target,
      ok: Boolean(r.resolved),
      critical: CRITICAL_ROUTES.has(r.route),
    })),
    missing_runtime_imports: missing,
    missing_count: missing.length,
    missing_critical_imports: missingCritical,
    missing_critical_count: missingCritical.length,
    dead_route_handlers: routeHandlers.filter((r) => !r.resolved && !CRITICAL_ROUTES.has(r.route)),
    pass: missing.length === 0,
    pass_full_closure: missing.length === 0,
  };

  const outArgIdx = process.argv.indexOf("--json-out");
  const outPath =
    outArgIdx >= 0 ? process.argv[outArgIdx + 1] : path.join(root, "scripts/output/AUDIT_RUNTIME_IMPORT_CLOSURE.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    `[audit_runtime_import_closure] files_in_closure=${visited.size} missing=${missing.length} pass=${report.pass}`,
  );
  if (missing.length) {
    for (const m of missing) {
      console.error(`  MISSING ${m.kind} ${m.spec} <= ${m.consumer}:${m.line}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
