import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const destPath = path.join(__dirname, "../src/legal/domain/politicaPrivacidadeBlocosCanonicos.js");

const CANAL = "contato@suse7.com.br";
const feCommit = "6e6b92b182a89b56f4b53a2b48b97b8fa466b4c7";

let body = execSync(
  `git -C "${path.join(repoRoot, "../suse7-frontend")}" show ${feCommit}:src/domain/legal/privacidadeBlocosProvisorio20260813.js`,
  { encoding: "utf8" },
);

body = body.replace(/^\uFEFF/, "");
body = body.replace(/^\/\/[^\n]*\n\/\/[^\n]*\n\n/, "");
body = body.replace(
  "export const PRIVACIDADE_BLOCOS_PROVISORIO_20260813",
  "export const POLITICA_PRIVACIDADE_BLOCOS_CANONICOS",
);
body = body.replace("[E-MAIL DE PRIVACIDADE DO SUSE7]", CANAL);
body = body.replace(
  '{ label: "[E-MAIL DE PRIVACIDADE]", boldLabel: true }',
  `{ label: "${CANAL}", boldLabel: true }`,
);

const header = `// Conteúdo canônico — Política de Privacidade V2 (13/08/2026) — SSOT backend (LEGAL.DOCUMENT.SSOT.01)
// Canal oficial de privacidade/LGPD: ${CANAL}

import { CANAL_CONTATO_OFICIAL_SUSE7 } from "./contatoInstitucionalSuse7.js";

void CANAL_CONTATO_OFICIAL_SUSE7;

`;

fs.writeFileSync(destPath, header + body, "utf8");
console.log("ok", fs.readFileSync(destPath, "utf8").includes(CANAL));
