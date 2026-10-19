/**
 * Utilidades de seguridad operativa compartidas por los filtros de
 * moderación. Independientes de grammY para poder probarlas de forma
 * unitaria y reutilizarlas entre handlers.
 *
 * - `KeyedMutex`: serializa el acceso por clave (chat) para evitar carreras
 *   entre handlers y la duplicación de sanciones por read-modify-write.
 * - `SlidingWindowCounter`: límite de frecuencia por ventana deslizante.
 * - `CooldownTracker`: evita repetir la misma sanción en un periodo corto.
 * - `sanitizeLogText`: minimiza datos personales y no guarda texto sensible
 *   completo en los registros.
 * - `callWithRetryAfter`: aplica backoff acotado ante respuestas 429.
 */

/** Ejecuta `fn` excluyéndola respecto a otras tareas con la misma clave. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, number>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      previous.then(() => gate),
    );
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      const remaining = (this.holders.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.holders.delete(key);
        this.tails.delete(key);
      } else {
        this.holders.set(key, remaining);
      }
    }
  }
}

const chatActionMutex = new KeyedMutex();

export function runChatActionExclusive<T>(
  chatId: number,
  operation: () => Promise<T>,
): Promise<T> {
  return chatActionMutex.runExclusive(String(chatId), operation);
}

/**
 * Contador por ventana deslizante. `record` añade un suceso y devuelve el
 * número de sucesos en la ventana (incluido el actual); los sucesos antiguos
 * se podan al superar `windowMs`, de modo que una ráfaga puntual expira sola.
 */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();

  record(key: string, now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return timestamps.length;
  }

  /** Sucesos en la ventana sin registrar uno nuevo. */
  peek(key: string, now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * Registra cuándo se aplicó por última vez una sanción y decide si toca
 * repetirla. Evita silencios/baneos duplicados en cascada para la misma
 * combinación usuario+motivo.
 */
export class CooldownTracker {
  private readonly lastApplied = new Map<string, number>();

  /** Devuelve `true` si procede aplicar y deja constancia. */
  shouldApply(key: string, now: number, cooldownMs: number): boolean {
    const previous = this.lastApplied.get(key);
    if (previous !== undefined && now - previous < cooldownMs) {
      return false;
    }
    this.lastApplied.set(key, now);
    return true;
  }

  /** Solo consulta, sin registrar. */
  isOnCooldown(key: string, now: number, cooldownMs: number): boolean {
    const previous = this.lastApplied.get(key);
    return previous !== undefined && now - previous < cooldownMs;
  }

  reset(key: string): void {
    this.lastApplied.delete(key);
  }
}

export interface TelegramErrorInfo {
  code?: number;
  retryAfterSeconds?: number;
  message: string;
}

/**
 * Describe un error de la API de Telegram sin volcar objetos completos.
 * `retry_after` aparece en errores 429 (too many requests).
 */
export function describeTelegramError(error: unknown): TelegramErrorInfo {
  if (typeof error !== "object" || error === null) {
    return { message: String(error).slice(0, 200) };
  }
  const record = error as Record<string, unknown>;
  const code =
    typeof record.error_code === "number" ? record.error_code : undefined;
  let retryAfterSeconds: number | undefined;
  const parameters = record.parameters;
  if (typeof parameters === "object" && parameters !== null) {
    const retry = (parameters as Record<string, unknown>).retry_after;
    if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) {
      retryAfterSeconds = Math.ceil(retry);
    }
  }
  const message =
    typeof record.description === "string"
      ? record.description.replace(/\s+/g, " ").slice(0, 200)
      : "unknown";
  return { code, retryAfterSeconds, message };
}

/** Indica si el error corresponde al límite de llamadas (429). */
export function isRateLimitError(error: unknown): boolean {
  return describeTelegramError(error).code === 429;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reintenta hasta tres veces ante 429. Respeta el `retry_after` de Telegram;
 * si no está disponible, aplica backoff exponencial. Otros errores se
 * propagan sin reintento.
 */
export async function callWithRetryAfter<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const info = describeTelegramError(error);
      if (info.code !== 429 || attempt >= maxRetries) {
        throw error;
      }
      const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
      const delayMs = Math.max(
        backoffMs,
        (info.retryAfterSeconds ?? 0) * 1000,
      );
      await sleep(delayMs);
    }
  }
}

const URL_LIKE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/giu;

/**
 * Prepara texto para un registro: sustituye enlaces y limita la longitud
 * para no persistir contenido sensible completo. Con contenido de abuso
 * sexual infantil NUNCA se debe usar: esa clase de contenido solo se
 * describe por su categoría, jamás por su texto.
 */
export function sanitizeLogText(text: string, maxLength = 120): string {
  const redacted = text.replace(URL_LIKE, "[enlace]");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}…`;
}
