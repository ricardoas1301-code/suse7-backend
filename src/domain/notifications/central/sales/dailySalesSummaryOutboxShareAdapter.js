import ExcelJS from "exceljs";
import { Resvg } from "@resvg/resvg-js";
import { renderSalesReportManualEmailBody } from "./renderSalesReportManualEmailBody.js";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_MIME = "image/png";
const IMAGE_FILENAME = "Resumo Executivo.png";
const XLSX_FILENAME = "Resumo de Vendas.xlsx";

const shareCache = new Map();

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trimTo(value, maxLen) {
  const text = String(value ?? "").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function normalizeTemplateVars(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    periodo: String(src.periodo ?? "Período não informado"),
    conta: String(src.conta ?? "Todas as contas"),
    vendas: String(src.vendas ?? "0"),
    faturamento: String(src.faturamento ?? "R$ 0,00"),
    lucro: String(src.lucro ?? "R$ 0,00"),
    margem: String(src.margem ?? "0 %"),
    saudaveis: String(src.saudaveis ?? "0"),
    margem_critica: String(src.margem_critica ?? "0"),
    prejuizo: String(src.prejuizo ?? "0"),
  };
}

function buildSummarySvg(vars) {
  const width = 1200;
  const height = 680;
  const header = "#1d4ed8";
  const bg = "#f8fafc";
  const card = "#ffffff";
  const text = "#0f172a";
  const muted = "#64748b";
  const accent = "#f97316";
  const period = escapeXml(trimTo(vars.periodo, 82));

  const metric = (label, value, x, y, color = text) => `
    <g transform="translate(${x} ${y})">
      <text x="0" y="0" font-family="Segoe UI, Arial, sans-serif" font-size="20" fill="${muted}" font-weight="700">${escapeXml(
        label
      )}</text>
      <text x="0" y="44" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="${color}" font-weight="800">${escapeXml(
        trimTo(value, 26)
      )}</text>
    </g>
  `;

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${bg}" />
    <rect x="0" y="0" width="${width}" height="122" fill="${header}" />
    <text x="52" y="60" font-family="Segoe UI, Arial, sans-serif" font-size="44" fill="#ffffff" font-weight="800">Resumo de vendas</text>
    <text x="52" y="96" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#dbeafe" font-weight="600">Período analisado: ${period}</text>

    <rect x="36" y="150" width="1128" height="494" rx="24" fill="${card}" stroke="#e2e8f0" />

    ${metric("Conta", vars.conta, 74, 216)}
    ${metric("Vendas", vars.vendas, 74, 322, accent)}
    ${metric("Faturamento", vars.faturamento, 404, 322)}
    ${metric("Lucro", vars.lucro, 754, 322)}
    ${metric("Margem", vars.margem, 74, 492)}
    ${metric("Saudáveis", vars.saudaveis, 404, 492)}
    ${metric("Margem crítica", vars.margem_critica, 754, 492)}
    <g transform="translate(404 572)">
      <text x="0" y="0" font-family="Segoe UI, Arial, sans-serif" font-size="20" fill="${muted}" font-weight="700">Prejuízo</text>
      <text x="0" y="44" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#dc2626" font-weight="800">${escapeXml(
        trimTo(vars.prejuizo, 26)
      )}</text>
    </g>
  </svg>
  `;
}

async function buildSummaryPngBase64(vars) {
  const svg = buildSummarySvg(vars);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    background: "white",
  });
  const png = resvg.render().asPng();
  return Buffer.from(png).toString("base64");
}

async function buildSummaryXlsxBase64(vars, input) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resumo");
  sheet.columns = [
    { header: "Campo", key: "field", width: 34 },
    { header: "Valor", key: "value", width: 52 },
  ];

  sheet.addRows([
    { field: "Período analisado", value: vars.periodo },
    { field: "Conta", value: vars.conta },
    { field: "Quantidade de vendas", value: vars.vendas },
    { field: "Faturamento", value: vars.faturamento },
    { field: "Lucro", value: vars.lucro },
    { field: "Margem", value: vars.margem },
    { field: "Saudáveis", value: vars.saudaveis },
    { field: "Margem crítica", value: vars.margem_critica },
    { field: "Prejuízo", value: vars.prejuizo },
    { field: "Event ID", value: input.eventId },
    { field: "Gerado em", value: new Date().toISOString() },
  ]);

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE2E8F0" },
    };
  });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf).toString("base64");
}

export function isDailySalesSummaryMetadata(metadata) {
  const category = String(metadata?.category_code ?? "").toUpperCase();
  const type = String(metadata?.type_key ?? "").toUpperCase();
  return category === "SALES" && type === "DAILY_SALES_SUMMARY";
}

/**
 * @param {{
 *  eventId: string;
 *  renderedSubject: string;
 *  renderedBody: string;
 *  variables?: Record<string, unknown>;
 *  recipientName?: string | null;
 * }} input
 */
export async function buildDailySalesSummaryOutboxShare(input) {
  const vars = normalizeTemplateVars(input.variables);
  const cacheKey = String(input.eventId ?? "").trim();

  if (cacheKey && shareCache.has(cacheKey)) {
    return shareCache.get(cacheKey);
  }

  const [imageBase64, documentBase64] = await Promise.all([
    buildSummaryPngBase64(vars),
    buildSummaryXlsxBase64(vars, input),
  ]);

  const email = renderSalesReportManualEmailBody({
    recipientName: input.recipientName ?? null,
    title: "Resumo de vendas do dia",
    introLine:
      "Seu resumo automático de vendas foi gerado e está disponível nos anexos deste e-mail.",
    attachmentLabelImage: "Resumo executivo",
    attachmentLabelDocument: "Planilha Excel do período",
  });

  const share = {
    imageBase64,
    imageMimeType: IMAGE_MIME,
    imageFilename: IMAGE_FILENAME,
    documentBase64,
    documentMimeType: XLSX_MIME,
    documentFilename: XLSX_FILENAME,
    whatsappCaption: String(input.renderedBody ?? ""),
    emailSubject: "Resumo de vendas do dia",
    emailHtml: email.html,
    emailText: email.text,
  };

  if (cacheKey) shareCache.set(cacheKey, share);
  return share;
}
