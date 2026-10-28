import { ALEXIITA_TELEGRAM_ID, OWNER_ID } from "../config.js";
import { getSystemOwnerId } from "../services/system-owner.js";

export function isAuthorizedPanelUserId(
  userId: number,
  currentOwnerId: number | undefined,
  configuredOwnerId: number | undefined = OWNER_ID,
  secondaryAdminId: number | undefined = ALEXIITA_TELEGRAM_ID,
): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return false;
  }

  const ownerId = currentOwnerId === undefined
    ? configuredOwnerId
    : currentOwnerId;
  return userId === ownerId || userId === secondaryAdminId;
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
    console.error(
      `[PANEL_AUTH] No se pudo comprobar el propietario actual userId=${userId} ` +
        `error=${error instanceof Error ? error.name : "unknown"} access=denied`,
    );
    return false;
  }
}
