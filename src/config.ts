import "dotenv/config";

/**
 * Configuración general del bot leída desde las variables de entorno.
 * Nunca pongas tokens de forma directa en el código.
 */
export const BOT_TOKEN = process.env.BOT_TOKEN;

function parseTelegramUserId(value: string | undefined): number | undefined {
  // Tolera comillas sobrantes de configuración ("123456") sin aceptar
  // formatos no numéricos: la identidad es siempre el ID numérico de Telegram.
  const normalized = value?.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const configuredIdentityValues = [
  process.env.OWNER_ID,
  process.env.ALEXIITA_TELEGRAM_ID,
  process.env.SYSTEM_OWNER_BOOTSTRAP_ID,
] as const;

export const OWNER_ID = parseTelegramUserId(configuredIdentityValues[0]);
export const ALEXIITA_TELEGRAM_ID = parseTelegramUserId(
  configuredIdentityValues[1],
);
export const SYSTEM_OWNER_BOOTSTRAP_ID = parseTelegramUserId(
  configuredIdentityValues[2],
);

export interface IdentityConfigurationDiagnostics {
  dotenvImportBeforeEvaluation: true;
  configuredValidDistinctIdentities: number;
  missingOrInvalidIdentities: number;
  identitiesAvailableAtEvaluation: boolean;
}

export function getIdentityConfigurationDiagnostics(
  values: readonly (string | undefined)[] = configuredIdentityValues,
): IdentityConfigurationDiagnostics {
  const parsed = values.map(parseTelegramUserId);
  const configuredValidDistinctIdentities = new Set(
    parsed.filter((id): id is number => id !== undefined),
  ).size;
  const missingOrInvalidIdentities = parsed.filter(
    (id) => id === undefined,
  ).length;

  return {
    dotenvImportBeforeEvaluation: true,
    configuredValidDistinctIdentities,
    missingOrInvalidIdentities,
    identitiesAvailableAtEvaluation: configuredValidDistinctIdentities > 0,
  };
}

/**
 * Identidades administrativas autorizadas: OWNER_ID, ALEXIITA_TELEGRAM_ID y
 * SYSTEM_OWNER_BOOTSTRAP_ID son las TRES cuentas con idéntica jerarquía y
 * permisos. La identidad es siempre el ID numérico de Telegram (los usernames
 * no autorizan). Ninguna comprobación debe dar privilegios exclusivos a una
 * de las tres ni excluirla de una función administrativa.
 */
export function isConfiguredAdminId(userId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  return (
    (OWNER_ID !== undefined && userId === OWNER_ID) ||
    (ALEXIITA_TELEGRAM_ID !== undefined && userId === ALEXIITA_TELEGRAM_ID) ||
    (SYSTEM_OWNER_BOOTSTRAP_ID !== undefined &&
      userId === SYSTEM_OWNER_BOOTSTRAP_ID)
  );
}

function parseCommaSeparatedValues(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/**
 * Dominios y usernames de Telegram separados por comas. Ejemplo:
 * LINK_WHITELIST=example.org,@official_channel
 */
export const LINK_WHITELIST = parseCommaSeparatedValues(
  process.env.LINK_WHITELIST,
);
export const LINK_FILTER_BLOCK_MENTIONS =
  process.env.LINK_FILTER_BLOCK_MENTIONS === "true";

/**
 * Términos explícitos separados por comas para revisar nombres públicos.
 * Vacío por defecto para evitar baneos basados en una lista genérica/ambigua.
 */
export const PROFILE_BLOCKED_TERMS = parseCommaSeparatedValues(
  process.env.PROFILE_BLOCKED_TERMS,
);

export const BOT_NAME = "Admin Bot";
export const BOT_DESCRIPTION =
  "Bot de administración y moderación para tu grupo de Telegram";

/**
 * Valida que las variables de entorno necesarias estén presentes.
 * Se llama al arrancar el bot para fallar rápido si falta el token.
 */
export function validateConfig(): void {
  if (!BOT_TOKEN) {
    throw new Error(
      "Falta la variable de entorno BOT_TOKEN. Configúrala en el archivo .env",
    );
  }
}
