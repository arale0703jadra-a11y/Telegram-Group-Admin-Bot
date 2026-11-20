import type {
  SecurityAction,
  SecurityCommandPayload,
  SecurityCommandResultState,
} from "./security-commands.js";

/**
 * Política de repetición de órdenes de seguridad (auditoría Fase 1–3).
 *
 * Este módulo es puro a propósito: no importa Supabase, grammY ni
 * almacenamiento, de modo que las reglas que deciden si una orden puede
 * repetirse se prueban sin base de datos ni red. La migración
 * `021_zeus_security_command_requeue.sql` replica exactamente estas reglas
 * dentro de PostgreSQL, porque la garantía atómica sólo puede vivir ahí.
 *
 * Principio rector: una orden sólo se repite cuando se puede demostrar que
 * (a) la ejecución no comenzó, (b) la intención sigue siendo válida y (c) un
 * operador autorizado asume explícitamente que la repetición podría revertir
 * una decisión humana posterior.
 */

/** Sufijo determinista añadido a la clave de la orden original. */
export const SECURITY_COMMAND_RETRY_SUFFIX = "#retry";

/** Profundidad máxima de la cadena `<clave>#retry#retry...`. */
export const MAX_SECURITY_COMMAND_RETRY_DEPTH = 3;

/** Límite de intentos de CERBERO (`claim_security_command`, migración 011). */
export const MAX_SECURITY_COMMAND_ATTEMPTS = 5;

/** Margen mínimo que debe quedar de un mute temporal para poder repetirlo. */
export const MUTE_MIN_REMAINING_MS = 30_000;

/**
 * Acciones que pueden repetirse *con confirmación humana explícita*.
 *
 * Quedan fuera, y por motivos verificables:
 * - `KICK_USER`: no es un estado absoluto; el ejecutor de CERBERO lo implementa
 *   como `ban` + `unban(only_if_banned)`. Una repetición puede desbanear a un
 *   usuario que fue baneado después, es decir, anula una decisión posterior.
 * - `WARN_USER`, `UNWARN_USER`, `UNWARN_ALL`: mutan contadores, no un estado.
 * - `DELETE_MESSAGE`: depende de mensajes que pueden haber desaparecido.
 * - `CLEAN_MESSAGES`: borrado masivo destructivo.
 *
 * Ninguna acción se considera "segura" por producir un estado final:
 * `BAN`/`UNBAN`/`UNMUTE` y las actualizaciones parciales pueden revertir una
 * decisión humana tomada después del intento original, así que exigen
 * confirmación explícita del operador.
 */
export const REPLAYABLE_SECURITY_ACTIONS: readonly SecurityAction[] = [
  "MUTE_USER",
  "UNMUTE_USER",
  "BAN_USER",
  "UNBAN_USER",
  "UPDATE_SECURITY_CONFIG",
  "UPDATE_PROTECTED_USER",
];

const REPLAYABLE_ACTION_SET: ReadonlySet<string> = new Set(
  REPLAYABLE_SECURITY_ACTIONS,
);

export function isReplayableSecurityAction(action: SecurityAction): boolean {
  return REPLAYABLE_ACTION_SET.has(action);
}

/**
 * Motivos de rechazo: conjunto cerrado para no interpretar textos libres.
 *
 * `execution_outcome_unknown` es un miembro histórico y ya NO se emite: la
 * corrección C9 unificó `result_state='unknown' + acknowledged=false` en
 * `confirmation_required`, porque la RPC de la migración 021 nunca distingue ese
 * estado (su único filtro de confirmación es
 * `coalesce(p_acknowledged, false) is not true`). Se conserva en el tipo para
 * que un valor heredado de una RPC anterior siga siendo un miembro del conjunto
 * cerrado y se trate como rechazo, no como éxito.
 */
export type SecurityCommandRequeueRefusalReason =
  | "invalid_request"
  | "not_found"
  | "not_processing"
  | "not_stale"
  | "not_retryable"
  | "temporal_window_expired"
  | "execution_may_have_started"
  | "execution_outcome_unknown"
  | "unsupported_result_state"
  | "attempts_exhausted"
  | "missing_operation_key"
  | "retry_limit_reached"
  | "already_retried"
  | "confirmation_required"
  | "unauthorized_operator"
  | "unauthorized_group"
  | "group_not_eligible"
  | "concurrent_change"
  | "requeue_rpc_unavailable"
  | "unexpected_rpc_outcome";

/**
 * Conjunto cerrado de motivos, en tiempo de ejecución.
 *
 * Existe para no convertir un `outcome` desconocido de la RPC en un miembro del
 * tipo mediante un cast (hallazgo B3). Un valor inesperado sigue siendo un
 * rechazo, con motivo propio y revisión humana.
 */
const REQUEUE_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "invalid_request",
  "not_found",
  "not_processing",
  "not_stale",
  "not_retryable",
  "temporal_window_expired",
  "execution_may_have_started",
  "execution_outcome_unknown",
  "unsupported_result_state",
  "attempts_exhausted",
  "missing_operation_key",
  "retry_limit_reached",
  "already_retried",
  "confirmation_required",
  "unauthorized_operator",
  "unauthorized_group",
  "group_not_eligible",
  "concurrent_change",
  "requeue_rpc_unavailable",
  "unexpected_rpc_outcome",
]);

/** Guardia de tipo para los motivos que devuelve la RPC. */
export function isSecurityCommandRequeueRefusalReason(
  value: unknown,
): value is SecurityCommandRequeueRefusalReason {
  return typeof value === "string" && REQUEUE_REFUSAL_REASONS.has(value);
}

/** Estados de evidencia exigidos por la Fase 3. */
export type SecurityCommandEvidenceState =
  | "never_started"
  | "maybe_started"
  | "reconciled_unknown"
  | "completed"
  | "failed"
  | "cancelled";


export interface SecurityCommandEvidenceRow {
  status?: string | null;
  result_state?: SecurityCommandResultState | null;
  execution_started_at?: string | null;
}

/**
 * Clasifica la evidencia disponible sobre la ejecución de una orden.
 *
 * `execution_started_at` tiene prioridad sobre `result_state = 'unknown'`
 * porque expresa una prueba positiva de que CERBERO llegó a marcar el inicio;
 * una orden reconciliada sin esa marca sólo indica que el resultado no se pudo
 * confirmar.
 */
export function classifySecurityCommandEvidence(
  row: SecurityCommandEvidenceRow,
): SecurityCommandEvidenceState {
  const status = (row.status ?? "").trim();
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (row.result_state === "completed") return "completed";
  if (row.result_state === "failed") return "failed";
  if (row.result_state === "cancelled") return "cancelled";
  if (
    typeof row.execution_started_at === "string" &&
    row.execution_started_at.length > 0
  ) {
    return "maybe_started";
  }
  if (row.result_state === "unknown") return "reconciled_unknown";
  return "never_started";
}

export interface SecurityCommandLeaseRow {
  status?: string | null;
  lease_expires_at?: string | null;
  processing_at?: string | null;
}

/** Ventana de gracia cuando la orden es `processing` pero no hay lease. */
export const STALE_PROCESSING_GRACE_MS = 5 * 60_000;

/**
 * `true` cuando una orden `processing` perdió su lease.
 *
 * - Un lease publicado en el pasado es autoritativo: el dueño ya no puede
 *   renovarlo.
 * - Un lease ausente sólo se acepta tras `processing_at` + ventana de gracia,
 *   porque la transacción de reclamo puede no haberlo publicado todavía.
 * - Sin lease y sin `processing_at` nunca se considera abandonada.
 */
export function isStaleSecurityCommandRow(
  row: SecurityCommandLeaseRow,
  now: number = Date.now(),
): boolean {
  if ((row.status ?? "").trim() !== "processing") return false;
  if (row.lease_expires_at) {
    const expires = Date.parse(row.lease_expires_at);
    return Number.isFinite(expires) ? expires <= now : false;
  }
  if (!row.processing_at) return false;
  const started = Date.parse(row.processing_at);
  return Number.isFinite(started)
    ? started + STALE_PROCESSING_GRACE_MS <= now
    : false;
}

/**
 * Cuenta cuántos sufijos de reintento tiene una clave de operación.
 *
 * La detección es por convención de cadena (igual que en la migración 021)
 * porque el esquema actual no tiene `retry_of`/`retry_depth`; la migración 022
 * propuesta en el informe sustituiría esta convención por columnas.
 */
export function countRetryDepth(
  operationKey: string,
  suffix: string = SECURITY_COMMAND_RETRY_SUFFIX,
): number {
  if (!suffix) return 0;
  let key = operationKey;
  let depth = 0;
  while (key.endsWith(suffix)) {
    depth += 1;
    key = key.slice(0, -suffix.length);
  }
  return depth;
}

export interface SecurityCommandReplayPolicyInput {
  action: SecurityAction;
  payload?: SecurityCommandPayload | null;
  status?: string | null;
  resultState?: SecurityCommandResultState | null;
  executionStartedAt?: string | null;
  leaseExpiresAt?: string | null;
  processingAt?: string | null;
  attempts?: number | null;
  operationKey?: string | null;
  /** El operador asumió que la repetición puede revertir decisiones posteriores. */
  acknowledged: boolean;
  now: number;
}

export interface SecurityCommandReplayPolicyDecision {
  allowed: boolean;
  requiresAcknowledgement: boolean;
  requiresHumanReview: boolean;
  reason?: SecurityCommandRequeueRefusalReason;
  detail?: string;
}

function decision(
  allowed: boolean,
  options: {
    requiresAcknowledgement?: boolean;
    requiresHumanReview?: boolean;
    reason?: SecurityCommandRequeueRefusalReason;
    detail?: string;
  } = {},
): SecurityCommandReplayPolicyDecision {
  const result: SecurityCommandReplayPolicyDecision = {
    allowed,
    requiresAcknowledgement: options.requiresAcknowledgement ?? false,
    requiresHumanReview: options.requiresHumanReview ?? false,
  };
  if (options.reason !== undefined) result.reason = options.reason;
  if (options.detail !== undefined) result.detail = options.detail;
  return result;
}

/**
 * Estados terminales: la orden ya no está en curso, así que repetirla no
 * restaura ningún estado.
 *
 * `queued` NO pertenece a este conjunto a propósito: la migración 021
 * (`result_state is null or result_state not in ('processing','unknown')`)
 * devuelve `unsupported_result_state` para él, y esta política debe devolver el
 * mismo motivo para que la paridad TS/SQL sea verificable en PostgreSQL real.
 */
const UNSUPPORTED_RESULT_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Devuelve el motivo por el que un mute temporal no puede repetirse, o
 * `undefined` si la ventana sigue siendo utilizable.
 *
 * Telegram interpreta un `until_date` en el pasado (o a menos de 30 s) como
 * "menos de 30 segundos desde ahora", que en la práctica se convierte en un
 * silenciamiento permanente. Repetir esa orden agrava la sanción en lugar de
 * restaurarla.
 */
export function getMuteWindowRefusal(
  payload: SecurityCommandPayload | null | undefined,
  now: number,
): string | undefined {
  if (!payload) return undefined;
  // 021 comprueba `payload ? 'until_date'`: una clave PRESENTE con valor `null`
  // (jsonb_typeof = 'null') no es "sin ventana" y se rechaza con
  // `temporal_window_expired`. Aceptarla aquí era la divergencia B1.
  if (payload.until_date === undefined) return undefined;
  const until = payload.until_date;
  if (typeof until !== "number" || !Number.isFinite(until)) {
    return "until_date no es un número de segundos válido";
  }
  const remaining = until * 1000 - now;
  if (remaining <= MUTE_MIN_REMAINING_MS) {
    return `until_date vencido o a menos de ${MUTE_MIN_REMAINING_MS / 1000}s`;
  }
  return undefined;
}


/**
 * Decide si una orden puede repetirse.
 *
 * Relación con `zeus_requeue_security_command` (migración 021), expresada sin
 * ambigüedad (hallazgo B2: antes se afirmaba que el orden era "el mismo"):
 *
 *  - Para las reglas que dependen sólo de la fila (estado, marca de inicio,
 *    lease, intentos, acción, ventana de mute, clave de operación y
 *    confirmación) el orden ES el mismo que en la RPC, y la matriz D de la
 *    suite de integración exige que el resultado coincida.
 *  - La RPC aplica además dos compuertas que dependen del ESTADO DE LA BASE y
 *    que esta función pura no puede evaluar: `already_retried` (ya existe un
 *    reintento con la clave `<clave>#retry`) y `group_not_eligible` (no hay
 *    binding habilitado con un bot Cerbero en un grupo activo). Por eso esta
 *    política es un SUBCONJUNTO ESTRICTO: puede rechazar, y la RPC puede
 *    rechazar además por esas dos causas. Nunca autoriza algo que la RPC vaya a
 *    rechazar por las reglas de fila, que es lo que la paridad exige.
 */
export function evaluateSecurityCommandReplayPolicy(
  input: SecurityCommandReplayPolicyInput,
): SecurityCommandReplayPolicyDecision {
  const status = (input.status ?? "").trim();
  if (status !== "processing") {
    return decision(false, {
      reason: "not_processing",
      detail: status || "unknown",
    });
  }

  const resultState = input.resultState ?? null;
  // Fail-closed: sin `result_state` no hay evidencia de nada. La migración 021
  // rechaza ese caso con `unsupported_result_state`; autorizarlo aquí sería una
  // divergencia insegura entre la política y la RPC.
  if (resultState === null) {
    return decision(false, {
      reason: "unsupported_result_state",
      detail: "null",
      requiresHumanReview: true,
    });
  }
  if (UNSUPPORTED_RESULT_STATES.has(resultState)) {
    return decision(false, { reason: "not_processing", detail: resultState });
  }
  if (resultState !== "processing" && resultState !== "unknown") {
    return decision(false, {
      reason: "unsupported_result_state",
      detail: String(resultState),
      requiresHumanReview: true,
    });
  }

  // Una marca de inicio es prueba positiva: no se repite nunca, ni siquiera
  // con confirmación, porque podría ejecutar dos veces la misma sanción.
  if (input.executionStartedAt) {
    return decision(false, {
      reason: "execution_may_have_started",
      detail: input.executionStartedAt,
      requiresHumanReview: true,
    });
  }

  if (resultState === "processing") {
    const stale = isStaleSecurityCommandRow(
      {
        status,
        lease_expires_at: input.leaseExpiresAt ?? null,
        processing_at: input.processingAt ?? null,
      },
      input.now,
    );
    if (!stale) {
      return decision(false, { reason: "not_stale" });
    }
  }

  const attempts = Number.isFinite(input.attempts) ? Number(input.attempts) : 0;
  if (attempts >= MAX_SECURITY_COMMAND_ATTEMPTS) {
    return decision(false, {
      reason: "attempts_exhausted",
      detail: String(attempts),
      requiresHumanReview: true,
    });
  }

  if (!isReplayableSecurityAction(input.action)) {
    return decision(false, { reason: "not_retryable", detail: input.action });
  }

  if (input.action === "MUTE_USER") {
    const muteRefusal = getMuteWindowRefusal(input.payload, input.now);
    if (muteRefusal) {
      return decision(false, {
        reason: "temporal_window_expired",
        detail: muteRefusal,
      });
    }
  }

  const operationKey = input.operationKey?.trim();
  if (!operationKey) {
    return decision(false, { reason: "missing_operation_key" });
  }
  if (countRetryDepth(operationKey) >= MAX_SECURITY_COMMAND_RETRY_DEPTH) {
    return decision(false, {
      reason: "retry_limit_reached",
      detail: operationKey,
      requiresHumanReview: true,
    });
  }

  // Toda acción repetible exige confirmación: no existe ninguna acción cuya
  // repetición no pueda revertir una decisión humana posterior.
  //
  // `result_state='unknown'` no tiene motivo propio (C9). La RPC 021 aplica un
  // único filtro de confirmación, sin mirar el estado:
  //   if v_outcome is null and coalesce(p_acknowledged, false) is not true
  // Emitir aquí `execution_outcome_unknown` rompía la paridad TS/SQL con una
  // razón que la RPC nunca devuelve. La severidad no se pierde: la orden sigue
  // siendo un rechazo (nunca una autorización) y `requiresHumanReview` conserva
  // el aviso de que el resultado no se pudo confirmar.
  if (!input.acknowledged) {
    const outcomeUnknown = resultState === "unknown";
    return decision(false, {
      reason: "confirmation_required",
      detail: outcomeUnknown
        ? `${input.action}: result_state=unknown (resultado no confirmado) y la repetición puede revertir decisiones humanas posteriores`
        : `${input.action}: la repetición puede revertir decisiones humanas posteriores`,
      requiresAcknowledgement: true,
      requiresHumanReview: outcomeUnknown,
    });
  }

  return decision(true, { requiresAcknowledgement: true });
}

/** Formato UUID canónico (el `id` de `security_commands` es uuid). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSecurityCommandId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}
