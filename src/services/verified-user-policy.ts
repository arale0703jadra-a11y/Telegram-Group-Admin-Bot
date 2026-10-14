export type TelegramUserStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked"
  | "unknown";

export function isActiveVerifiedRecord(
  record: { verified?: boolean; revoked_at?: string | null } | undefined,
): boolean {
  return Boolean(record?.verified && !record.revoked_at);
}

export function shouldSkipPromotionFilter(
  filterEnabled: boolean,
  bypassPromotionFilter: boolean,
): boolean {
  return !filterEnabled || bypassPromotionFilter;
}

export function shouldSkipIllegalFilter(
  bypassIllegalFilter: boolean,
  critical: boolean,
): boolean {
  return bypassIllegalFilter && !critical;
}

export function shouldSkipAutomaticDeletion(
  bypassAutomaticDeletion: boolean,
  critical: boolean,
): boolean {
  return bypassAutomaticDeletion && !critical;
}

export function getVerifiedMessageRestriction(
  permissions: { can_post: boolean; can_send_media: boolean },
  hasMedia: boolean,
): "posting_disabled" | "media_disabled" | undefined {
  if (!permissions.can_post) return "posting_disabled";
  if (hasMedia && !permissions.can_send_media) return "media_disabled";
  return undefined;
}

export function shouldSkipOrdinarySpamViolation(
  bypassAntispam: boolean,
  violationType: string,
): boolean {
  if (!bypassAntispam) return false;
  return violationType !== "prohibited_word" && violationType !== "repeat_offender";
}

export function canRevokeVerifiedAdministrator(input: {
  status: TelegramUserStatus;
  isBot: boolean;
  isVerified: boolean;
  isProtected: boolean;
  botCanPromote: boolean;
}): boolean {
  return (
    input.status === "administrator" &&
    !input.isBot &&
    input.isVerified &&
    !input.isProtected &&
    input.botCanPromote
  );
}

export function buildUserStatusBadges(
  status: TelegramUserStatus,
  verified: boolean,
): string[] {
  const badges: string[] = [];
  if (status === "creator") badges.push("👑 Owner");
  else if (status === "administrator") badges.push("🛡️ Administradora");
  else if (status === "member" || status === "restricted") badges.push("👤 Usuario");
  else if (status === "left") badges.push("↪️ Fuera del grupo");
  else if (status === "kicked") badges.push("🔨 Baneado");
  else badges.push("❔ Estado no disponible");
  if (verified) badges.push("✅ Verificada");
  return badges;
}
