import type { Api } from "grammy";
import { getGroupData } from "../storage/index.js";
import type { GroupData } from "../storage/types.js";
import { findConfiguredVerifiedMarker } from "./verified-marker-detection.js";
import {
  getVerifiedUserRecord,
} from "./verified-users.js";
import { isActiveVerifiedRecord } from "./verified-user-policy.js";
import {
  getVerifiedTagReview,
  recordVerifiedTagObservation,
} from "./verified-tag-reviews.js";

const RECENT_ACTIVITY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export interface VerifiedMarkerScanResult {
  scanned: number;
  newCandidates: number;
}

export class VerifiedMarkerAdminLookupError extends Error {
  constructor(
    readonly permissionDenied: boolean,
    options?: ErrorOptions,
  ) {
    super(
      permissionDenied
        ? "Telegram no permitió consultar los administradores del grupo."
        : "No se pudo consultar la lista de administradores en Telegram.",
      options,
    );
    this.name = "VerifiedMarkerAdminLookupError";
  }
}

/**
 * Etapas del escaneo que dependen del registro persistente de ZEUS
 * (Supabase). Etiquetar cada etapa permite saber exactamente dónde falló un
 * escaneo sin exponer credenciales ni volcados crudos de peticiones.
 */
export type VerifiedMarkerScanStage =
  | "load_group_data"
  | "admin_lookup"
  | "verified_record_lookup"
  | "review_lookup"
  | "candidate_registration";

/** Motivo clasificado de un fallo del registro persistente. */
export type VerifiedMarkerStoreFailureReason =
  | "missing_configuration"
  | "missing_table"
  | "network"
  | "unknown";

export class VerifiedMarkerScanError extends Error {
  constructor(
    readonly stage: VerifiedMarkerScanStage,
    readonly reason: VerifiedMarkerStoreFailureReason,
    options?: ErrorOptions,
  ) {
    super(
      `El escaneo falló en la etapa ${stage} (motivo: ${reason}).`,
      options,
    );
    this.name = "VerifiedMarkerScanError";
  }
}

const MISSING_CONFIGURATION_MARKERS = [
  "Faltan credenciales de Supabase",
  "Falta la configuración de Supabase",
  "Faltan SUPABASE_URL",
];

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
]);

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : {};
}

function readErrorCode(error: unknown): string {
  const record = errorRecord(error);
  const code = record.code ?? record.error_code;
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : "";
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = errorRecord(error);
  const message = record.message ?? record.description;
  return typeof message === "string" ? message : "";
}

/**
 * Clasifica un error del registro persistente en un motivo accionable.
 * `missing_table` cubre tanto `42P01` (undefined_table) como `PGRST205`
 * (tabla ausente del caché de esquemas de PostgREST), que es lo que produce
 * una migración pendiente.
 */
export function classifyVerifiedStoreFailure(
  error: unknown,
): VerifiedMarkerStoreFailureReason {
  const message = readErrorMessage(error);
  if (MISSING_CONFIGURATION_MARKERS.some((marker) => message.includes(marker))) {
    return "missing_configuration";
  }
  const code = readErrorCode(error);
  if (MISSING_TABLE_CODES.has(code)) return "missing_table";
  if (message.includes("Could not find the table")) return "missing_table";
  if (NETWORK_ERROR_CODES.has(code)) return "network";
  if (message.includes("fetch failed")) return "network";
  if (error instanceof TypeError && /fetch|network|socket/i.test(message)) {
    return "network";
  }
  return "unknown";
}

/**
 * Valores que jamás deben aparecer en los registros de diagnóstico:
 * tokens de bots de Telegram, JWT y claves de servicio de Supabase.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b\d{6,15}:[A-Za-z0-9_-]{25,}\b/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{10,}\b/g,
  /\bsbp_[A-Za-z0-9_-]{10,}\b/g,
];

const MAX_SCAN_DETAIL_LENGTH = 300;

/** Redacta credenciales y colapsa el texto usado en los logs del escaneo. */
export function sanitizeScanDetail(value: string): string {
  let sanitized = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTADO]");
  }
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return sanitized.length > MAX_SCAN_DETAIL_LENGTH
    ? `${sanitized.slice(0, MAX_SCAN_DETAIL_LENGTH)}…`
    : sanitized;
}

function describeCause(error: unknown): string {
  if (error === undefined || error === null) return "sin-causa";
  const name = error instanceof Error ? error.name : typeof error;
  const code = readErrorCode(error);
  const message = readErrorMessage(error);
  return sanitizeScanDetail(
    `${name}${code ? ` code=${code}` : ""}${message ? ` message=${message}` : ""}`,
  );
}

/**
 * Devuelve una única línea técnica segura (sin tokens, claves ni URLs con
 * credenciales) que identifica la etapa y el motivo de un fallo del escaneo.
 */
export function describeVerifiedMarkerScanError(error: unknown): string {
  if (error instanceof VerifiedMarkerScanError) {
    return (
      `etapa=${error.stage} motivo=${error.reason} ` +
      `causa=${describeCause(error.cause)}`
    );
  }
  if (error instanceof VerifiedMarkerAdminLookupError) {
    return (
      `etapa=admin_lookup permisoDenegado=${error.permissionDenied} ` +
      `causa=${describeCause(error.cause)}`
    );
  }
  return `etapa=desconocida causa=${describeCause(error)}`;
}

async function runScanStage<T>(
  stage: VerifiedMarkerScanStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new VerifiedMarkerScanError(
      stage,
      classifyVerifiedStoreFailure(error),
      { cause: error },
    );
  }
}

function isPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.error_code === 403) return true;
  const description =
    typeof record.description === "string" ? record.description.toLowerCase() : "";
  return (
    description.includes("not enough rights") ||
    description.includes("not an administrator") ||
    description.includes("forbidden")
  );
}

export async function scanObservedVerifiedMarkers(
  api: Pick<Api, "getChatAdministrators">,
  groupId: number,
  data: GroupData,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedMarkerScanResult> {
  const activityCutoff = now - RECENT_ACTIVITY_WINDOW_SECONDS;
  const recentUsers = new Map<
    number,
    { username?: string; displayName: string; markerFields: string[] }
  >();

  for (const user of Object.values(data.indexedUsers)) {
    const activeStatus =
      user.status === "creator" ||
      user.status === "administrator" ||
      user.status === "member" ||
      user.status === "restricted";
    const recentlySeen =
      typeof user.lastSeen === "number" && user.lastSeen >= activityCutoff;
    if (!activeStatus && !recentlySeen) continue;
    recentUsers.set(user.id, {
      username: user.username || undefined,
      displayName:
        user.displayName ?? user.name ??
        [user.firstName, user.lastName].filter(Boolean).join(" "),
      markerFields: [
        user.firstName ?? "",
        user.lastName ?? "",
        user.name ?? "",
        user.displayName ?? "",
        user.username ?? "",
      ],
    });
  }

  for (const message of data.activityMessages) {
    if (message.timestamp < activityCutoff) continue;
    const existing = recentUsers.get(message.userId);
    const displayName =
      [message.firstName, message.lastName].filter(Boolean).join(" ") ||
      message.name ||
      existing?.displayName ||
      "";
    recentUsers.set(message.userId, {
      username: message.username ?? existing?.username,
      displayName,
      markerFields: [
        message.firstName ?? "",
        message.lastName ?? "",
        message.name ?? "",
        message.username ?? "",
        ...(existing?.markerFields ?? []),
      ],
    });
  }

  let administrators: Awaited<ReturnType<Api["getChatAdministrators"]>>;
  try {
    administrators = await api.getChatAdministrators(groupId);
  } catch (error) {
    throw new VerifiedMarkerAdminLookupError(isPermissionError(error), {
      cause: error,
    });
  }
  for (const administrator of administrators) {
    if (administrator.status !== "administrator" || administrator.user.is_bot) {
      continue;
    }
    const customTitle =
      "custom_title" in administrator &&
      typeof administrator.custom_title === "string"
        ? administrator.custom_title
        : "";
    if (!findConfiguredVerifiedMarker([customTitle], data.verifiedMemberTags)) {
      continue;
    }
    const existing = recentUsers.get(administrator.user.id);
    recentUsers.set(administrator.user.id, {
      username: administrator.user.username ?? existing?.username,
      displayName:
        [administrator.user.first_name, administrator.user.last_name]
          .filter(Boolean)
          .join(" ") ||
        existing?.displayName ||
        `ID ${administrator.user.id}`,
      markerFields: [
        customTitle,
        ...(existing?.markerFields ?? []),
      ],
    });
  }

  let newCandidates = 0;
  for (const [userId, user] of recentUsers) {
    const marker = findConfiguredVerifiedMarker(
      user.markerFields,
      data.verifiedMemberTags,
    );
    if (!marker) continue;

    const existing = await runScanStage("verified_record_lookup", () =>
      getVerifiedUserRecord(groupId, userId),
    );
    if (isActiveVerifiedRecord(existing, new Date(now * 1000))) continue;

    const priorReview = await runScanStage("review_lookup", () =>
      getVerifiedTagReview(groupId, userId),
    );
    if (priorReview) continue;
    newCandidates++;
    await runScanStage("candidate_registration", () =>
      recordVerifiedTagObservation({
        groupId,
        userId,
        username: user.username,
        displayName: user.displayName,
        observedTag: `${marker} (escaneo de título/perfil/actividad reciente)`,
        status: "pending",
      }),
    );
  }

  return { scanned: recentUsers.size, newCandidates };
}

export interface VerifiedMarkerScanOutcome {
  /** `true` cuando el escaneo terminó; `false` si hubo un fallo controlado. */
  ok: boolean;
  /** Mensaje amigable para responder en el panel. */
  userMessage: string;
  /** Contexto técnico seguro para el registro interno (logs). */
  detail: string;
}

const SCAN_SUCCESS_MESSAGE = (scanned: number, newCandidates: number): string =>
  `🔎 Escaneo completado: ${scanned} usuarios observados; ` +
  `✅ ${newCandidates} candidatas nuevas para revisión.\n\n` +
  "Las coincidencias no otorgan automáticamente el estado Verificada.";

const ADMIN_PERMISSION_MESSAGE =
  "⚠️ Telegram no permitió consultar los administradores. Comprueba que ZEUS siga en el grupo y tenga permisos de administrador.";
const ADMIN_CONNECTION_MESSAGE =
  "⚠️ No se pudo obtener la lista de administradores de Telegram. Inténtalo de nuevo cuando se recupere la conexión.";
const STORE_MISSING_CONFIGURATION_MESSAGE =
  "⚠️ El escaneo necesita la configuración de la base de datos de ZEUS para guardar candidatas. " +
  "No se modificó ningún registro; revisa la configuración del bot e inténtalo de nuevo.";
const STORE_MISSING_TABLE_MESSAGE =
  "⚠️ Falta una tabla en la base de datos de ZEUS. Aplica la migración pendiente del proyecto y vuelve a escanear. " +
  "No se modificó ningún registro.";
const STORE_NETWORK_MESSAGE =
  "⚠️ No se pudo contactar con la base de datos de ZEUS durante el escaneo. " +
  "Los registros existentes se conservaron; inténtalo más tarde.";
const STORE_GENERIC_MESSAGE =
  "⚠️ No se pudo completar el escaneo por un error al guardar los datos. Inténtalo de nuevo más tarde.";
const READ_GENERIC_MESSAGE =
  "⚠️ No se pudo completar el escaneo por un error al leer los datos. Inténtalo de nuevo más tarde.";

/**
 * Ejecuta el escaneo manual del panel y devuelve tanto el mensaje para la
 * usuaria como una línea técnica segura. No lanza excepciones: cada fallo se
 * clasifica para poder diagnosticarlo sin ocultar la causa real.
 *
 * El escaneo nunca borra ni modifica registros ya existentes: solo añade
 * candidatas pendientes cuyo título personalizado coincida con las marcas
 * configuradas.
 */
export async function runVerifiedMarkerScan(input: {
  api: Pick<Api, "getChatAdministrators">;
  groupId: number;
  /** Permite inyectar los datos del grupo en pruebas. */
  data?: GroupData;
}): Promise<VerifiedMarkerScanOutcome> {
  const { api, groupId } = input;
  let data = input.data;
  if (!data) {
    try {
      data = await getGroupData(groupId);
    } catch (error) {
      return {
        ok: false,
        userMessage: READ_GENERIC_MESSAGE,
        detail:
          `etapa=load_group_data motivo=` +
          `${classifyVerifiedStoreFailure(error)} ` +
          `causa=${describeCause(error)}`,
      };
    }
  }

  try {
    const result = await scanObservedVerifiedMarkers(api, groupId, data);
    return {
      ok: true,
      userMessage: SCAN_SUCCESS_MESSAGE(result.scanned, result.newCandidates),
      detail: `etapa=completado escaneados=${result.scanned} candidatas=${result.newCandidates}`,
    };
  } catch (error) {
    const detail = describeVerifiedMarkerScanError(error);
    if (error instanceof VerifiedMarkerAdminLookupError) {
      return {
        ok: false,
        userMessage: error.permissionDenied
          ? ADMIN_PERMISSION_MESSAGE
          : ADMIN_CONNECTION_MESSAGE,
        detail,
      };
    }
    if (error instanceof VerifiedMarkerScanError) {
      const userMessage =
        error.reason === "missing_configuration"
          ? STORE_MISSING_CONFIGURATION_MESSAGE
          : error.reason === "missing_table"
            ? STORE_MISSING_TABLE_MESSAGE
            : error.reason === "network"
              ? STORE_NETWORK_MESSAGE
              : STORE_GENERIC_MESSAGE;
      return { ok: false, userMessage, detail };
    }
    return { ok: false, userMessage: READ_GENERIC_MESSAGE, detail };
  }
}
