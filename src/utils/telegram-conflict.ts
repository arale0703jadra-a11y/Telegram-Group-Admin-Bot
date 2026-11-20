/**
 * Detección del conflicto de polling de Telegram (auditoría Fase 3).
 *
 * Telegram responde `409 Conflict` cuando dos procesos llaman a `getUpdates`
 * con el mismo token. Es la señal más fiable de una instancia duplicada y no
 * requiere ninguna llamada adicional a la API: se analiza el error que grammY
 * ya ha recibido.
 *
 * Se exige contexto de `getUpdates` (o la forma exacta `409: Conflict`) para no
 * confundir errores de otro origen —por ejemplo un conflicto de concurrencia de
 * PostgreSQL (40001)— con dos procesos haciendo polling.
 */

const POLLING_CONFLICT_PATTERNS: readonly RegExp[] = [
  /terminated by other getUpdates request/iu,
  /getUpdates[\s\S]*?\b409\b/iu,
  /\b409\b[\s\S]*?getUpdates/iu,
  /\b409:\s*conflict/iu,
];

export function isTelegramPollingConflict(message: string): boolean {
  if (!message) return false;
  return POLLING_CONFLICT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Mensaje operativo único, sin datos sensibles, para los logs de ZEUS. */
export const TELEGRAM_POLLING_CONFLICT_HINT =
  "409 Conflict: otra instancia está haciendo polling con el mismo BOT_TOKEN. " +
  "Detén la instancia duplicada (Railway debe tener 1 réplica) antes de seguir; " +
  "ver RUNBOOK.md §13.";
