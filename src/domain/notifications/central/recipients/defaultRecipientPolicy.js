// =============================================================================
// Política canônica — destinatário padrão da empresa principal (SUSE7)
// Identificação estrutural: is_primary + seller_company_id + metadata.recipient_kind
// =============================================================================

/** @readonly */
export const S7_RECIPIENT_KIND = Object.freeze({
  PRIMARY_COMPANY: "PRIMARY_COMPANY",
});

/** @readonly */
export const DEFAULT_RECIPIENT_ERROR = Object.freeze({
  PRIMARY_DELETE_FORBIDDEN: "PRIMARY_RECIPIENT_DELETE_FORBIDDEN",
  PRIMARY_CONTACT_LOCKED: "PRIMARY_RECIPIENT_CONTACT_LOCKED",
});

/**
 * @param {unknown} metadata
 */
export function parseRecipientMetadata(metadata) {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (metadata);
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isPrimaryCompanyRecipientRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.is_primary === true) return true;
  const meta = parseRecipientMetadata(row.metadata);
  return meta.recipient_kind === S7_RECIPIENT_KIND.PRIMARY_COMPANY;
}

/**
 * @param {Record<string, unknown> | null | undefined} group
 */
export function isPrimaryCompanyRecipientGroup(group) {
  if (!group || typeof group !== "object") return false;
  if (group.is_primary === true) return true;
  const meta = parseRecipientMetadata(group.metadata);
  return meta.recipient_kind === S7_RECIPIENT_KIND.PRIMARY_COMPANY;
}

/**
 * @param {Record<string, unknown> | null | undefined} group
 */
export function canDeleteRecipientGroup(group) {
  return !isPrimaryCompanyRecipientGroup(group);
}

/**
 * @param {Record<string, unknown> | null | undefined} group
 */
export function canEditPrimaryRecipientContactFields(group) {
  return !isPrimaryCompanyRecipientGroup(group);
}

/**
 * @param {Record<string, unknown> | null | undefined} group
 */
export function canDeactivatePrimaryRecipientGroup() {
  return true;
}

/**
 * @param {Record<string, unknown>} metadata
 */
export function hasBootstrapPreferencesCompleted(metadata) {
  const meta = parseRecipientMetadata(metadata);
  return meta.bootstrap_preferences_at != null && String(meta.bootstrap_preferences_at).trim() !== "";
}

/**
 * @param {Record<string, unknown>} metadata
 */
export function isRecipientLabelCustomized(metadata) {
  const meta = parseRecipientMetadata(metadata);
  return meta.label_customized === true;
}

/**
 * @param {Record<string, unknown>} metadata
 * @param {Partial<Record<string, unknown>>} patch
 */
export function mergeRecipientMetadata(metadata, patch) {
  const base = parseRecipientMetadata(metadata);
  return { ...base, ...patch };
}
