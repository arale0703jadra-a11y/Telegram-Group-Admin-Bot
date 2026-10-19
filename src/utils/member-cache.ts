/**
 * Caché de consultas de membresía/permisos con caducidad y cooldown ante 429.
 *
 * Motivo (auditoría Fase 1, riesgo H1): cada filtro llamaba a getChatMember
 * por mensaje; bajo una oleada de spam Telegram responde 429 y los filtros se
 * omitían justo cuando más se necesitaban. Esta caché colapsa las consultas
 * repetidas en una ventana corta y, ante un 429, deja de llamar a la API
 * durante el tiempo `retry_after` (con tope de 30 s) en lugar de insistir.
 *
 * Política de errores explícita:
 * - Autorización (permisos de administrador): sin respuesta => DENEGADO.
 *   Nunca se concede permiso por defecto.
 * - Sanciones automáticas (filtros): sin respuesta verificable => se OMITE la
 *   sanción (no se sanciona a quien no se pudo verificar). Esta decisión
 *   preserva el comportamiento previo y queda documentada en
 *   SECURITY_PHASE1.md.
 *
 * Este módulo es puro: no importa configuración, grammY ni almacenamiento,
 * por lo que puede probarse sin leer .env ni contactar con Telegram.
 */
import type { ChatMember } from "@grammyjs/types";

export interface MemberLookupApi {
  getChatMember(chatId: number | string, userId: number): Promise<ChatMember>;
}

export interface CachedBotRights {
  canRestrict: boolean;
  canDelete: boolean;
}

export const MEMBER_CACHE_TTL_MS = 10_000;
export const BOT_RIGHTS_CACHE_TTL_MS = 60_000;
export const MEMBER_CACHE_MAX_ENTRIES = 500;
export const BOT_RIGHTS_CACHE_MAX_ENTRIES = 300;
export const MAX_COOLDOWN_MS = 30_000;

/** Mapa con expiración por entrada y cota de tamaño (evictión FIFO). */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Pausa de llamadas por clave (chat) cuando Telegram responde 429. */
export class ApiCooldown {
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxPauseMs: number = MAX_COOLDOWN_MS,
  ) {}

  /** Aplica una pausa; nunca acorta una pausa ya mayor en curso. */
  pause(chatKey: string, retryAfterSeconds: number): void {
    const clamped = Math.min(Math.max(1, retryAfterSeconds), Math.ceil(this.maxPauseMs / 1000));
    const until = this.now() + clamped * 1000;
    const current = this.pausedUntil.get(chatKey) ?? 0;
    if (until > current) this.pausedUntil.set(chatKey, until);
  }

  isPaused(chatKey: string): boolean {
    const until = this.pausedUntil.get(chatKey);
    return until !== undefined && until > this.now();
  }

  clear(): void {
    this.pausedUntil.clear();
  }
}

function errorInfo(error: unknown): { code?: number; retryAfterSeconds?: number } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const code =
    typeof record.error_code === "number" && Number.isSafeInteger(record.error_code)
      ? record.error_code
      : undefined;
  const parameters = record.parameters;
  let retryAfterSeconds: number | undefined;
  if (typeof parameters === "object" && parameters !== null) {
    const retry = (parameters as Record<string, unknown>).retry_after;
    if (typeof retry === "number" && Number.isFinite(retry) && retry >= 0) {
      retryAfterSeconds = Math.ceil(retry);
    }
  }
  return { code, retryAfterSeconds };
}

export interface SecurityCaches {
  /** getChatMember seguro: caché 10 s, cooldown 429, nunca lanza. */
  getCachedChatMember(
    api: MemberLookupApi,
    chatId: number,
    userId: number,
  ): Promise<ChatMember | undefined>;
  /** Permisos del bot: caché 60 s; sin respuesta verificable => denegado. */
  getCachedBotRights(
    api: MemberLookupApi,
    chatId: number,
    botId: number,
  ): Promise<CachedBotRights>;
  /** Invalida una entrada de miembro y los derechos del chat. */
  invalidateSecurityCaches(chatId: number, userId?: number): void;
  /** Vacía por completo (para pruebas). */
  resetSecurityCaches(): void;
}

export function createSecurityCaches(options?: {
  now?: () => number;
  memberTtlMs?: number;
  rightsTtlMs?: number;
  memberMaxEntries?: number;
  rightsMaxEntries?: number;
  maxPauseMs?: number;
}): SecurityCaches {
  const now = options?.now ?? Date.now;
  const memberCache = new TtlCache<ChatMember>(
    options?.memberTtlMs ?? MEMBER_CACHE_TTL_MS,
    options?.memberMaxEntries ?? MEMBER_CACHE_MAX_ENTRIES,
    now,
  );
  const rightsCache = new TtlCache<CachedBotRights>(
    options?.rightsTtlMs ?? BOT_RIGHTS_CACHE_TTL_MS,
    options?.rightsMaxEntries ?? BOT_RIGHTS_CACHE_MAX_ENTRIES,
    now,
  );
  const cooldowns = new ApiCooldown(now, options?.maxPauseMs ?? MAX_COOLDOWN_MS);

  const denyRights: CachedBotRights = Object.freeze({ canRestrict: false, canDelete: false });

  function registerRateLimit(chatId: number, error: unknown): void {
    const info = errorInfo(error);
    if (info.code !== 429) return;
    cooldowns.pause(String(chatId), info.retryAfterSeconds ?? 5);
    console.warn(
      `[ZEUS] Límite de llamadas (429) en el chat ${chatId}; consultas en pausa ${Math.min(info.retryAfterSeconds ?? 5, 30)}s.`,
    );
  }

  async function getCachedChatMember(
    api: MemberLookupApi,
    chatId: number,
    userId: number,
  ): Promise<ChatMember | undefined> {
    const key = `${chatId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached) return structuredClone(cached);
    if (cooldowns.isPaused(String(chatId))) return undefined;
    try {
      const member = await api.getChatMember(chatId, userId);
      memberCache.set(key, member);
      return structuredClone(member);
    } catch (error) {
      registerRateLimit(chatId, error);
      return undefined;
    }
  }

  async function getCachedBotRights(
    api: MemberLookupApi,
    chatId: number,
    botId: number,
  ): Promise<CachedBotRights> {
    const key = `${chatId}:${botId}`;
    const cached = rightsCache.get(key);
    if (cached) return { ...cached };
    if (cooldowns.isPaused(String(chatId))) return { ...denyRights };
    try {
      const member = await api.getChatMember(chatId, botId);
      const rights: CachedBotRights =
        member.status === "administrator"
          ? {
              canRestrict:
                "can_restrict_members" in member ? member.can_restrict_members : false,
              canDelete:
                "can_delete_messages" in member ? member.can_delete_messages : false,
            }
          : { ...denyRights };
      rightsCache.set(key, rights);
      return { ...rights };
    } catch (error) {
      registerRateLimit(chatId, error);
      return { ...denyRights };
    }
  }

  function invalidateSecurityCaches(chatId: number, userId?: number): void {
    if (userId === undefined) {
      memberCache.deleteByPrefix(`${chatId}:`);
    } else {
      // Borrado exacto: un prefijo con el userId podría afectar a otros
      // usuarios cuyo ID empiece por las mismas cifras (1 vs 12).
      memberCache.delete(`${chatId}:${userId}`);
    }
    rightsCache.deleteByPrefix(`${chatId}:`);
  }

  function resetSecurityCaches(): void {
    memberCache.clear();
    rightsCache.clear();
    cooldowns.clear();
  }

  return {
    getCachedChatMember,
    getCachedBotRights,
    invalidateSecurityCaches,
    resetSecurityCaches,
  };
}

/** Instancia compartida del proceso. */
export const securityCaches = createSecurityCaches();

export const getCachedChatMember =
  securityCaches.getCachedChatMember;
export const getCachedBotRights =
  securityCaches.getCachedBotRights;
export const invalidateSecurityCaches =
  securityCaches.invalidateSecurityCaches;
export const resetSecurityCaches =
  securityCaches.resetSecurityCaches;
