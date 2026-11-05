/**
 * Agrupación y limitación de los avisos de persistencia de sesiones.
 *
 * Este estado controla EXCLUSIVAMENTE el envío de avisos a Telegram.
 * Nunca modifica la operación de persistencia (los errores se propagan
 * siempre) ni el registro técnico (cada fallo se registra en logs con
 * detalle completo, se avise o no al usuario).
 *
 * Reglas:
 * - Un aviso por incidente: fallos equivalentes (misma operación+motivo+
 *   código de base de datos) se agrupan y solo se registra en logs.
 * - Frecuencia limitada: aunque cambie la firma del error, no se envían
 *   avisos más separados que `minNoticeIntervalMs`. Si un aviso queda
 *   retenido, se envía en el siguiente fallo cuando cumpla el intervalo.
 * - Un aviso de recuperación: cuando vuelve a persistirse correctamente
 *   tras un incidente notificado, se avisa una sola vez.
 */

export interface SessionPersistenceFailure {
  operation: string;
  reason: string;
  databaseCode?: string;
}

export type SessionAlertNotice =
  | "sent"
  | "delayed"
  | "grouped"
  | "rate-limited";

export interface SessionAlertDecision {
  notify: boolean;
  occurrence: number;
  notice: SessionAlertNotice;
}

interface SessionIncident {
  signature: string;
  firstAt: number;
  lastAt: number;
  occurrences: number;
  pendingNotice: boolean;
  notified: boolean;
}

const DEFAULT_MIN_NOTICE_INTERVAL_MS = 5 * 60 * 1_000;

export class SessionPersistenceAlerts {
  private incident: SessionIncident | undefined;
  private outageNotified = false;
  private lastNoticeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly minNoticeIntervalMs: number = DEFAULT_MIN_NOTICE_INTERVAL_MS,
  ) {}

  /** Registra un fallo de persistencia y decide si se avisa al usuario. */
  recordFailure(failure: SessionPersistenceFailure): SessionAlertDecision {
    const timestamp = this.now();
    const signature =
      `${failure.operation}:${failure.reason}:${failure.databaseCode ?? "-"}`;
    let incident = this.incident;
    if (incident === undefined || incident.signature !== signature) {
      incident = {
        signature,
        firstAt: timestamp,
        lastAt: timestamp,
        occurrences: 1,
        pendingNotice: true,
        notified: false,
      };
      this.incident = incident;
    } else {
      incident.occurrences += 1;
      incident.lastAt = timestamp;
    }
    const occurrence = incident.occurrences;
    if (
      incident.pendingNotice &&
      timestamp - this.lastNoticeAt >= this.minNoticeIntervalMs
    ) {
      this.lastNoticeAt = timestamp;
      incident.pendingNotice = false;
      incident.notified = true;
      this.outageNotified = true;
      return {
        notify: true,
        occurrence,
        notice: occurrence === 1 ? "sent" : "delayed",
      };
    }
    if (!incident.pendingNotice) {
      return { notify: false, occurrence, notice: "grouped" };
    }
    return { notify: false, occurrence, notice: "rate-limited" };
  }

  /**
   * Registra una operación de persistencia correcta.
   * Devuelve `true` solo si procede notificar la recuperación tras un
   * incidente que sí llegó a notificarse.
   */
  recordSuccess(): boolean {
    const notifyRecovery = this.outageNotified;
    this.incident = undefined;
    this.outageNotified = false;
    return notifyRecovery;
  }

  /** Estado observable para pruebas y diagnóstico. */
  snapshot():
    | { signature: string; occurrences: number; notified: boolean }
    | undefined {
    if (!this.incident) return undefined;
    return {
      signature: this.incident.signature,
      occurrences: this.incident.occurrences,
      notified: this.incident.notified,
    };
  }
}
