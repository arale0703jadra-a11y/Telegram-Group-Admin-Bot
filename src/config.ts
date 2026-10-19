import "dotenv/config";

/**
 * Configuración general del bot leída desde las variables de entorno.
 * Nunca pongas tokens de forma directa en el código.
 */
export const BOT_TOKEN = process.env.BOT_TOKEN;

export const OWNER_ID = process.env.OWNER_ID
  ? Number(process.env.OWNER_ID)
  : undefined;

export const SYSTEM_OWNER_BOOTSTRAP_ID = process.env.SYSTEM_OWNER_BOOTSTRAP_ID
  ? Number(process.env.SYSTEM_OWNER_BOOTSTRAP_ID)
  : undefined;

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
