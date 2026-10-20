import type { AntiRaidConfig, EmergencyConfig } from "../storage/types.js";
import { SlidingWindowCounter } from "../utils/safety.js";
import { sanitizeIncomingText } from "../utils/sanitizer.js";

/**
 * Motor de detección de oleadas (raids) y actividad coordinada.
 *
 * Es deliberadamente independiente de grammY: recibe eventos (entradas,
 * mensajes) con una marca de tiempo y devuelve decisiones. El estado vive en
 * memoria del proceso y se vacía al reiniciar; los UMBRALES y la duración de
 * las restricciones sí se persisten por grupo en la configuración.
 *
 * IMPORTANTE: la API de Bots de Telegram no expone la fecha de creación de
 * una cuenta. Por eso "cuenta nueva" significa aquí "recién llegada al
 * grupo" (medido por el tiempo desde su `joinedAt` observable), y nunca se
 * juzga a alguien solo por su nombre, foto, antigüedad o falta de actividad
 * previa.
 */
export interface JoinFloodResult {
  raid: boolean;
  joinsInWindow: number;
}

export interface CoordinatedResult {
  coordinated: boolean;
  distinctUsers: number;
}

export const EMERGENCY_MEMBER_AGE_MS = 48 * 60 * 60 * 1000;

/** `joinedAt` in storage is epoch seconds; unknown or invalid dates are not recent. */
export function isRecentEmergencyMember(
  joinedAt: number | undefined,
  now: number,
): boolean {
  if (
    joinedAt === undefined ||
    !Number.isSafeInteger(joinedAt) ||
    joinedAt <= 0
  ) {
    return false;
  }
  const joinedAtMs = joinedAt * 1000;
  return joinedAtMs <= now && now - joinedAtMs < EMERGENCY_MEMBER_AGE_MS;
}

export function normalizeCoordinationText(text: string): string {
  return sanitizeIncomingText(text)
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export class AntiRaidEngine {
  private readonly joins = new SlidingWindowCounter();
  private readonly coordinated = new Map<string, SlidingWindowCounter>();

  /** Registra una entrada y detecta si cruza el umbral de oleada. */
  recordJoin(
    chatId: number,
    now: number,
    config: AntiRaidConfig,
  ): JoinFloodResult {
    const windowMs = config.joinWindowSeconds * 1000;
    const joinsInWindow = this.joins.record(`j:${chatId}`, now, windowMs);
    return {
      raid: joinsInWindow >= config.joinThreshold,
      joinsInWindow,
    };
  }

  /**
   * Registra un mensaje y detecta actividad coordinada: el mismo texto
   * enviado por varios usuarios distintos en la ventana. Solo cuenta una vez
   * por usuario dentro de la ventana para no inflarlo con repetidos.
   */
  recordCoordinatedMessage(
    chatId: number,
    userId: number,
    text: string,
    now: number,
    config: AntiRaidConfig,
  ): CoordinatedResult {
    const normalized = normalizeCoordinationText(text);
    if (!normalized || normalized.length < 8) {
      return { coordinated: false, distinctUsers: 0 };
    }
    const key = `c:${chatId}:${normalized}`;
    let counter = this.coordinated.get(key);
    if (!counter) {
      counter = new SlidingWindowCounter();
      this.coordinated.set(key, counter);
    }
    const windowMs = config.coordinatedWindowSeconds * 1000;
    // Usa una clave por usuario para contar usuarios distintos.
    const distinctUsers = counter.record(`u:${userId}`, now, windowMs);
    return {
      coordinated: distinctUsers >= config.coordinatedThreshold,
      distinctUsers,
    };
  }

  /**
   * Indica si `joinedAt` (epoch ms) está dentro de la ventana de restricción
   * para cuentas recién llegadas. Devuelve `false` si no conocemos la fecha.
   */
  isRecentMember(
    joinedAtMs: number | undefined,
    now: number,
    config: AntiRaidConfig,
  ): boolean {
    if (joinedAtMs === undefined) {
      return false;
    }
    const windowMs = config.newAccountRestrictionMinutes * 60 * 1000;
    return now - joinedAtMs < windowMs;
  }
}

/** Activa el modo de emergencia con una expiración concreta. */
export function activateEmergency(
  current: EmergencyConfig,
  reason: string,
  now: number,
  minutes: number,
): EmergencyConfig {
  return {
    active: true,
    reason,
    activatedAt: now,
    expiresAt: now + Math.max(1, minutes) * 60 * 1000,
  };
}

/**
 * Devuelve `true` si el modo de emergencia sigue vigente. Si ya caducó,
 * devuelve `false` (el llamador puede persistir el estado desactivado).
 */
export function isEmergencyActive(
  emergency: EmergencyConfig,
  now: number,
): boolean {
  if (!emergency.active) {
    return false;
  }
  if (emergency.expiresAt !== undefined && emergency.expiresAt <= now) {
    return false;
  }
  return true;
}

/** Desactiva (o normaliza) el modo de emergencia cuando caducó. */
export function expireEmergencyIfNeeded(
  emergency: EmergencyConfig,
  now: number,
): EmergencyConfig {
  if (emergency.active && !isEmergencyActive(emergency, now)) {
    return { active: false };
  }
  return emergency;
}
