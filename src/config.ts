import "dotenv/config";

/**
 * Configuración general del bot leída desde las variables de entorno.
 * Nunca pongas tokens de forma directa en el código.
 */
export const BOT_TOKEN = process.env.BOT_TOKEN;

export const OWNER_ID = process.env.OWNER_ID
  ? Number(process.env.OWNER_ID)
  : undefined;

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
