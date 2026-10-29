import {
  ALEXIITA_TELEGRAM_ID,
  OWNER_ID,
  SYSTEM_OWNER_BOOTSTRAP_ID,
} from "../config.js";
import { getSystemOwnerId } from "../services/system-owner.js";

/**
 * Identidades autorizadas para el panel — IGUALDAD TOTAL entre las tres
 * cuentas configuradas (OWNER_ID, ALEXIITA_TELEGRAM_ID y
 * SYSTEM_OWNER_BOOTSTRAP_ID) y la propiedad técnica persistida en la BD
 * `system_owner` (alcanzable solo por bootstrap o transferencia con clave,
 * explícitos y auditados). Las tres cuentas tienen la misma jerarquía:
 * ninguna queda excluida por no ser OWNER_ID ni el System Owner persistido.
 * Un cambio de username no afecta: la identidad es el ID numérico.
 */
export function isAuthorizedPanelUserId(
  userId: number,
  currentOwnerId: number | undefined,
  configuredOwnerId: number | undefined = OWNER_ID,
  secondaryAdminId: number | undefined = ALEXIITA_TELEGRAM_ID,
  bootstrapAdminId: number | undefined = SYSTEM_OWNER_BOOTSTRAP_ID,
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return false;
  }

  const authorizedIds = [
    currentOwnerId,
    configuredOwnerId,
    secondaryAdminId,
    bootstrapAdminId,
  ].filter(
    (id): id is number =>
      typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  );
  return authorizedIds.includes(userId);
}

export async function isAuthorizedPanelUser(
  userId: number,
  ownerLookup: () => Promise<number | undefined> = getSystemOwnerId,
): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return false;
  }

  try {
    const currentOwnerId = await ownerLookup();
    return isAuthorizedPanelUserId(userId, currentOwnerId);
  } catch (error) {
    // Sin acceso a la BD no se amplía el conjunto: se conservan las
    // identidades configuradas en el entorno (mismo límite de 3 usuarios).
    console.error(
      `[PANEL_AUTH] No se pudo comprobar el propietario actual userId=${userId} ` +
        `error=${error instanceof Error ? error.name : "unknown"} access=configured-fallback`,
    );
    return isAuthorizedPanelUserId(userId, undefined);
  }
}
