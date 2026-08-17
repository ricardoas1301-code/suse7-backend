// =============================================================================
// S7 — Central Sininho Oficial (Fase S5.8)
// Contrato operacional do canal in_app — infraestrutura, sem eventos de negócio.
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

/** Código canônico (Registro Oficial de Canais S5.3). */
export const S7_SININHO_CHANNEL_CODE = S7_NOTIFICATION_CHANNEL.IN_APP;

/** Aliases reconhecidos pelo registro. */
export const S7_SININHO_CHANNEL_ALIASES = Object.freeze(["sininho", "bell", "inbox"]);

/** Severidades de exibição no inbox (alinha ao contrato global). */
export const S7_SININHO_SEVERITY = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
});

/** Ciclo de vida do item no inbox (dispatch channel=in_app). */
export const S7_SININHO_INBOX_STATUS = Object.freeze({
  PENDING: "pending",
  QUEUED: "queued",
  SENT: "sent",
  DELIVERED: "delivered",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/** Estado de leitura do item (colunas + metadata.inbox). */
export const S7_SININHO_READ_STATE = Object.freeze({
  UNREAD: "unread",
  READ: "read",
});

/** Arquivamento — estrutura futura (coluna archived_at S5.8). */
export const S7_SININHO_ARCHIVE_STATE = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
});

/** Categorias futuras (sem regra de negócio nesta fase). */
export const S7_SININHO_FUTURE_CATEGORY = Object.freeze({
  OPERATIONAL: "operational",
  FINANCIAL: "financial",
  MARKETPLACE: "marketplace",
  ADMINISTRATIVE: "administrative",
});

/** Persistência primária do inbox. */
export const S7_SININHO_INBOX_TABLE = "s7_notification_dispatches";

/** Provider interno (entrega imediata, persistência no dispatch). */
export const S7_SININHO_OFFICIAL_PROVIDER = "s7_in_app";

/** APIs seller do inbox (sem alterar rotas). */
export const S7_SININHO_INBOX_API = Object.freeze({
  LIST: "/api/notifications/inbox",
  MARK_READ: "/api/notifications/inbox/:id/read",
  MARK_ALL_READ: "/api/notifications/inbox/read-all",
});
