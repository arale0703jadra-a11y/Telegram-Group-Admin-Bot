import type { Context } from "grammy";

/**
 * Manejo centralizado de errores del bot.
 * Evita que un fallo en un mensaje detenga el funcionamiento del bot.
 */
export function errorBoundary(error: unknown): never {
  const message =
    error instanceof Error ? error.message : "Error desconocido";
  console.error("[ERROR del bot]", message);
  throw error;
}