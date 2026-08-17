#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.resolve(workspaceRoot, "suse7-frontend");
const outputDir = path.resolve(backendRoot, "scripts", "output");

const RULES = {
  HIST001_LIVE_FALLBACK: "S7-HIST-001",
  HIST002_FLOAT_MONEY: "S7-HIST-002",
  HIST003_PARALLEL_PROFIT_MARGIN: "S7-HIST-003",
  HIST004_SILENT_FALLBACK: "S7-HIST-004",
};

const BLOCKED_PATH_RE = /(notification|notific|export|excel|print|pdf|whatsapp|email)/i;
const FINANCIAL_PATH_RE =
  /(sales|vendas|product|produto|summary|executive|rayx|report|relatorio|pricing|precifica|cost|custo|tax|imposto|margin|margem|profit|lucro)/i;

const FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

const PATH_KEYWORDS = [
  "sales",
  "vendas",
  "product",
  "produto",
  "summary",
  "executive",
  "rayx",
  "report",
  "relatorio",
  "notification",
  "notific",
  "export",
  "pricing",
  "cost",
  "custo",
  "tax",
  "imposto",
  "margin",
  "margem",
  "profit",
  "lucro",
];

const EXPLICIT_CRITICAL_FILES = new Set([
  toRepoPath(path.resolve(backendRoot, "src/domain/sales/loadSaleOrderItemForSeller.js")),
  toRepoPath(path.resolve(backendRoot, "src/handlers/sales/summary.js")),
  toRepoPath(path.resolve(frontendRoot, "src/utils/productCatalogRow.js")),
]);

const STRICT_ERROR_PATHS = [
  /suse7-backend\/src\/domain\/sales\/loadSaleOrderItemForSeller\.js$/i,
  /suse7-backend\/src\/handlers\/sales\/summary\.js$/i,
  /suse7-backend\/src\/handlers\/sales\/detail\.js$/i,
  /suse7-backend\/src\/handlers\/sales\/_vendasSalesRows\.js$/i,
  /suse7-backend\/src\/domain\/sales\/saleDetailInternalCosts\.js$/i,
  /suse7-backend\/src\/domain\/sales\/saleExecutiveLineRealResult\.js$/i,
  /suse7-backend\/src\/services\/marketplace\/mercadoLivreSaleFinancialEnrichment\.js$/i,
  /suse7-frontend\/src\/utils\/productCatalogRow\.js$/i,
];

const LEGACY_WARNING_PATHS = [
  /suse7-backend\/src\/domain\/sales\/saleDetailInternalCosts\.js$/i,
];

const SCAN_ROOTS = [
  path.resolve(backendRoot, "src"),
  path.resolve(backendRoot, "api"),
  path.resolve(backendRoot, "scripts"),
  path.resolve(frontendRoot, "src"),
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cursor",
]);

function toRepoPath(absPath) {
  const rel = path.relative(workspaceRoot, absPath);
  return rel.split(path.sep).join("/");
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

function safeSnippet(line) {
  return String(line ?? "").trim().slice(0, 220);
}

function hasSuppressionTag(line) {
  return /ssot-guard:ignore/i.test(line);
}

function isBlockedPath(repoPath) {
  return BLOCKED_PATH_RE.test(repoPath);
}

function isFinancialPath(repoPath) {
  return FINANCIAL_PATH_RE.test(repoPath);
}

function isStrictErrorPath(repoPath) {
  return STRICT_ERROR_PATHS.some((re) => re.test(repoPath));
}

function isLegacyWarningPath(repoPath) {
  return LEGACY_WARNING_PATHS.some((re) => re.test(repoPath));
}

function classifySeverity(defaultSeverity, repoPath, line) {
  if (hasSuppressionTag(line)) return "INFO";
  if (isBlockedPath(repoPath)) return "WARNING";
  if (isLegacyWarningPath(repoPath)) return "WARNING";
  if (isStrictErrorPath(repoPath)) return defaultSeverity;
  return "SKIP";
}

function shouldScanFile(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (!FILE_EXTENSIONS.has(ext)) return false;
  const repoPath = toRepoPath(absPath).toLowerCase();
  if (EXPLICIT_CRITICAL_FILES.has(toRepoPath(absPath))) return true;
  return PATH_KEYWORDS.some((keyword) => repoPath.includes(keyword));
}

async function walkFiles(rootDir) {
  const out = [];
  try {
    const stats = await fs.stat(rootDir);
    if (!stats.isDirectory()) return out;
  } catch {
    return out;
  }

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (entry.isFile() && shouldScanFile(full)) out.push(full);
    }
  }

  await visit(rootDir);
  return out;
}

function createFinding({
  repoPath,
  lineNumber,
  line,
  rule,
  title,
  defaultSeverity,
  suggestion,
}) {
  const severity = classifySeverity(defaultSeverity, repoPath, line);
  if (severity === "SKIP") return null;
  return {
    file: repoPath,
    line: lineNumber,
    rule_id: rule,
    rule_title: title,
    severity,
    snippet: safeSnippet(line),
    suggestion,
  };
}

function scanLines(repoPath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  const financialPath = isFinancialPath(repoPath);
  const pushFinding = (finding) => {
    if (finding) findings.push(finding);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineNo = idx + 1;
    const trimmed = line.trim();
    const lower = line.toLowerCase();
    const isComment = /^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^\*/.test(trimmed);
    if (isComment) continue;
    const moneyContext = /(revenue|receita|gross|net|profit|lucro|margin|margem|fee|cost|custo|tax|imposto|amount|valor|ticket)/i.test(
      line,
    );

    // S7-HIST-001: fallback vivo em venda historica
    if (/resolveSaleInternalTaxProfile\s*\(/.test(line) && !/function\s+resolveSaleInternalTaxProfile/.test(line)) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST001_LIVE_FALLBACK,
          title: "Uso de perfil fiscal atual em fluxo historico",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Substituir por leitura exclusiva de _s7_financial (tax_snapshot/internal_costs_snapshot).",
        }),
      );
    }
    if (/\.from\(["'`](products|product_variants|seller_companies|profiles|marketplace_listing_health)["'`]\)/i.test(line)) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST001_LIVE_FALLBACK,
          title: "Lookup potencial de configuracao atual em fluxo financeiro",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Evitar lookup vivo em historico; usar snapshot persistido e marcar snapshot_missing quando ausente.",
        }),
      );
    }
    if (/(current_cost|current_tax|live[_\s-]?config|tax_profile)/i.test(line) && financialPath) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST001_LIVE_FALLBACK,
          title: "Referencia a custo/imposto/configuracao atual",
          defaultSeverity: "WARNING",
          suggestion:
            "Revisar se a origem e historica (_s7_financial). Se for legado permitido, documentar com ssot-guard:ignore.",
        }),
      );
    }

    // S7-HIST-002: float em calculo monetario
    if (/parseFloat\s*\(/.test(line) && financialPath) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST002_FLOAT_MONEY,
          title: "parseFloat em contexto financeiro",
          defaultSeverity: "ERROR",
          suggestion: "Trocar por Decimal ou NUMERIC no backend.",
        }),
      );
    }
    if (moneyContext && /\bNumber\s*\(/.test(line)) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST002_FLOAT_MONEY,
          title: "Number(...) em valor monetario",
          defaultSeverity: "ERROR",
          suggestion: "Usar Decimal para parse e operacoes financeiras.",
        }),
      );
    }
    if (moneyContext && /Math\.round\s*\(/.test(line)) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST002_FLOAT_MONEY,
          title: "Math.round em valor monetario",
          defaultSeverity: "ERROR",
          suggestion: "Arredondar com Decimal.toDecimalPlaces e regra explicita.",
        }),
      );
    }
    if (
      financialPath &&
      /\b(let|const)\s+(gross|net|revenue|receita|profit|lucro|fees?|cost|custo|tax|imposto)\w*\s*=\s*0\b/i.test(line)
    ) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST002_FLOAT_MONEY,
          title: "Acumulador monetario inicializado como number",
          defaultSeverity: "WARNING",
          suggestion: "Inicializar como new Decimal(0) quando for valor monetario.",
        }),
      );
    }

    // S7-HIST-003: calculo paralelo de lucro/margem
    if (
      /\b(profit|lucro|margin|margem|grossProfit)\b\s*=\s*[^;]*(revenue|receita|net|gross)[^;]*(-|\/)[^;]*(cost|custo|revenue|receita)\b/i.test(
        line,
      ) &&
      !/Decimal/i.test(line)
    ) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST003_PARALLEL_PROFIT_MARGIN,
          title: "Operacao paralela de lucro/custo detectada",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Consumir lucro/margem de campo canonico SSOT (snapshot/agregacao oficial), sem recomputar em fallback.",
        }),
      );
    }
    if (
      /(profit|lucro|margin|margem)[^;\n]{0,30}\/[^;\n]{0,30}(revenue|receita|net|gross)/i.test(line) &&
      !/Decimal/i.test(line)
    ) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST003_PARALLEL_PROFIT_MARGIN,
          title: "Percentual financeiro sem Decimal/campo canonico",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Usar valor percentual canonico do backend ou calcular com Decimal no backend.",
        }),
      );
    }

    // S7-HIST-004: fallback silencioso
    if (/(fallback|default|padrao).{0,50}(current|atual).{0,40}(cost|custo|tax|imposto)/i.test(lower)) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST004_SILENT_FALLBACK,
          title: "Fallback silencioso potencial quando snapshot ausente",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Quando snapshot_missing, retornar nulo/indisponivel e flag explicita; nunca usar custo/imposto atual.",
        }),
      );
    }
    if (
      /snapshot_missing/i.test(line) &&
      /(\?\s*[^:;]*(cost|custo|tax|imposto|current|atual)[^:;]*:\s*[^;]+)/i.test(line)
    ) {
      pushFinding(
        createFinding({
          repoPath,
          lineNumber: lineNo,
          line,
          rule: RULES.HIST004_SILENT_FALLBACK,
          title: "Fallback por ternario com snapshot_missing",
          defaultSeverity: financialPath ? "ERROR" : "WARNING",
          suggestion:
            "Quando snapshot_missing, retornar nulo/indisponivel e flag explicita; nunca usar custo/imposto atual.",
        }),
      );
    }
  }

  return findings;
}

async function main() {
  const timestamp = nowStamp();
  const findings = [];
  const scannedFiles = [];

  for (const root of SCAN_ROOTS) {
    const files = await walkFiles(root);
    for (const absFile of files) {
      let content = "";
      try {
        content = await fs.readFile(absFile, "utf8");
      } catch {
        continue;
      }
      const repoPath = toRepoPath(absFile);
      scannedFiles.push(repoPath);
      findings.push(...scanLines(repoPath, content));
    }
  }

  const uniqueFindings = dedupeFindings(findings);
  const summary = {
    errors: uniqueFindings.filter((f) => f.severity === "ERROR").length,
    warnings: uniqueFindings.filter((f) => f.severity === "WARNING").length,
    infos: uniqueFindings.filter((f) => f.severity === "INFO").length,
    total: uniqueFindings.length,
    scanned_files: scannedFiles.length,
  };

  const report = {
    generated_at: new Date().toISOString(),
    script: "scripts/ssot_guard_check.mjs",
    scope: {
      roots: SCAN_ROOTS.map((dir) => toRepoPath(dir)),
      blocked_paths_policy: "Areas de notificacoes/exportacoes rebaixam ERROR para WARNING ate checkout completo",
      critical_rules: Object.values(RULES),
    },
    summary,
    findings: uniqueFindings,
  };

  await fs.mkdir(outputDir, { recursive: true });
  const reportFile = path.resolve(outputDir, `ssot_guard_check_${timestamp}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[SSOT GUARD] Arquivos escaneados: ${summary.scanned_files}`);
  console.log(
    `[SSOT GUARD] ERROR=${summary.errors} WARNING=${summary.warnings} INFO=${summary.infos} TOTAL=${summary.total}`,
  );
  console.log(`[SSOT GUARD] Relatorio: ${toRepoPath(reportFile)}`);

  if (summary.errors > 0) {
    process.exitCode = 1;
  }
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.rule_id}:${f.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

await main();
