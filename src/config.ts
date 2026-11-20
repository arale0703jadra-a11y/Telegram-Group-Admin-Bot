import "dotenv/config";

/**
 * Configuración general del bot leída desde las variables de entorno.
 * Nunca pongas tokens de forma directa en el código.
 */
export const BOT_TOKEN = process.env.BOT_TOKEN;

function parseTelegramUserId(value: string | undefined): number | undefined {
  // Tolera comillas sobrantes de configuración ("123456") sin aceptar
  // formatos no numéricos: la identidad es siempre el ID numérico de Telegram.
  const normalized = value?.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const configuredIdentityValues = [
  process.env.OWNER_ID,
  process.env.ALEXIITA_TELEGRAM_ID,
  process.env.SYSTEM_OWNER_BOOTSTRAP_ID,
] as const;

export const OWNER_ID = parseTelegramUserId(configuredIdentityValues[0]);
export const ALEXIITA_TELEGRAM_ID = parseTelegramUserId(
  configuredIdentityValues[1],
);
export const SYSTEM_OWNER_BOOTSTRAP_ID = parseTelegramUserId(
  configuredIdentityValues[2],
);

export interface IdentityConfigurationDiagnostics {
  dotenvImportBeforeEvaluation: true;
  configuredValidDistinctIdentities: number;
  missingIdentities: number;
  invalidIdentities: number;
  missingOrInvalidIdentities: number;
  identitiesAvailableAtEvaluation: boolean;
}

export function getIdentityConfigurationDiagnostics(
  values: readonly (string | undefined)[] = configuredIdentityValues,
): IdentityConfigurationDiagnostics {
  const parsed = values.map(parseTelegramUserId);
  const missingIdentities = values.filter((value) => !value?.trim()).length;
  const invalidIdentities = values.filter(
    (value, index) => Boolean(value?.trim()) && parsed[index] === undefined,
  ).length;
  const configuredValidDistinctIdentities = new Set(
    parsed.filter((id): id is number => id !== undefined),
  ).size;
  const missingOrInvalidIdentities = missingIdentities + invalidIdentities;

  return {
    dotenvImportBeforeEvaluation: true,
    configuredValidDistinctIdentities,
    missingIdentities,
    invalidIdentities,
    missingOrInvalidIdentities,
    identitiesAvailableAtEvaluation: configuredValidDistinctIdentities > 0,
  };
}

/**
 * Identidades administrativas autorizadas: OWNER_ID, ALEXIITA_TELEGRAM_ID y
 * SYSTEM_OWNER_BOOTSTRAP_ID son las TRES cuentas con idéntica jerarquía y
 * permisos. La identidad es siempre el ID numérico de Telegram (los usernames
 * no autorizan). Ninguna comprobación debe dar privilegios exclusivos a una
 * de las tres ni excluirla de una función administrativa.
 */
export function isConfiguredAdminId(userId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  return (
    (OWNER_ID !== undefined && userId === OWNER_ID) ||
    (ALEXIITA_TELEGRAM_ID !== undefined && userId === ALEXIITA_TELEGRAM_ID) ||
    (SYSTEM_OWNER_BOOTSTRAP_ID !== undefined &&
      userId === SYSTEM_OWNER_BOOTSTRAP_ID)
  );
}

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
 * Bots de servicio autorizados explícitamente, identificados SIEMPRE por su
 * ID numérico de Telegram (nunca por nombre, username ni fotografía).
 *
 * ZEUS no se configura aquí: se protege a sí mismo en tiempo de ejecución con
 * `ctx.me.id`, la identidad real que devuelve Telegram al arrancar.
 *
 * PENDIENTE — CERBERO: no existe una fuente local fiable de su ID numérico.
 * `CERBERO_INSTANCE_ID` es un identificador de instancia, no el ID del bot de
 * Telegram, y no se inventa ninguno. Configúralo con
 * `CERBERO_TELEGRAM_BOT_ID=<id numérico real>`.
 *
 * Mientras un bot de servicio declarado siga sin ID, ZEUS NO expulsa a ningún
 * bot: no podría garantizar que el que entra no sea CERBERO. La salvaguarda se
 * levanta solo al configurar ese ID real.
 */
export const CERBERO_BOT_ID = parseTelegramUserId(
  process.env.CERBERO_TELEGRAM_BOT_ID,
);

/**
 * Bots de servicio adicionales autorizados, separados por comas y solo con
 * IDs numéricos. Ejemplo: SECURITY_EXTRA_BOT_IDS=123456789,987654321
 * Esta es la vía más rápida de ampliar la lista en el futuro.
 *
 * Esta variable NUNCA sustituye al ID obligatorio de CERBERO: ver
 * `pendingServiceBotLabels()`, que depende únicamente de `CERBERO_BOT_ID`.
 *
 * Las entradas malformadas NO se descartan en silencio: se clasifican en
 * `INVALID_EXTRA_BOT_ID_ENTRIES` y se avisa al arrancar con
 * `getServiceBotConfigWarnings()`. Ese aviso expone solo posición, longitud
 * y motivo, nunca el valor original, que podría ser algo pegado por error
 * (p. ej. un token).
 */
export interface InvalidExtraBotIdEntry {
  /** Posición 1-based dentro de la lista separada por comas. */
  index: number;
  /** Longitud de la entrada original: permite localizarla sin mostrarla. */
  length: number;
  reason: "formato-no-numérico" | "entero-fuera-de-rango" | "valor-no-positivo";
}

function classifyExtraBotIdEntry(
  value: string,
): InvalidExtraBotIdEntry["reason"] | undefined {
  if (!/^\d+$/u.test(value)) return "formato-no-numérico";
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return "entero-fuera-de-rango";
  if (parsed <= 0) return "valor-no-positivo";
  return undefined;
}

const extraBotIdEntries = parseCommaSeparatedValues(
  process.env.SECURITY_EXTRA_BOT_IDS,
);

export const INVALID_EXTRA_BOT_ID_ENTRIES: readonly InvalidExtraBotIdEntry[] =
  extraBotIdEntries.flatMap(
    (value, position): InvalidExtraBotIdEntry[] => {
      const reason = classifyExtraBotIdEntry(value);
      return reason === undefined
        ? []
        : [{ index: position + 1, length: value.length, reason }];
    },
  );

export const EXTRA_SERVICE_BOT_IDS: readonly number[] = [
  ...new Set(
    extraBotIdEntries
      .filter((value) => classifyExtraBotIdEntry(value) === undefined)
      .map((value) => Number(value)),
  ),
];

/**
 * IDs numéricos de bots de servicio autorizados, sin incluir a ZEUS
 * (que se resuelve en tiempo de ejecución con `ctx.me.id`).
 */
export function allowedServiceBotIds(): number[] {
  return [
    ...new Set([
      ...(CERBERO_BOT_ID === undefined ? [] : [CERBERO_BOT_ID]),
      ...EXTRA_SERVICE_BOT_IDS,
    ]),
  ];
}

/**
 * Bots de servicio declarados cuyo ID numérico sigue pendiente.
 * Si la lista no está vacía, la expulsión automática de bots queda
 * desactivada (protección frente a expulsiones accidentales).
 */
export function pendingServiceBotLabels(): readonly string[] {
  return CERBERO_BOT_ID === undefined ? ["CERBERO"] : [];
}

// ===== D. Verificación de identidad de CERBERO =====
// EVALUADA Y NO IMPLEMENTADA. No existe una fuente local fiable que relacione
// `CERBERO_TELEGRAM_BOT_ID` con la identidad real de CERBERO. Comprobado en el
// código local de CERBERO:
//  - La tabla `bots` guarda `id uuid` e `instance_id text`; nunca el ID
//    numérico de Telegram (CERBERO/supabase/migrations/001_initial_schema.sql).
//  - `registerBot()` devuelve ese UUID, no el ID del bot
//    (CERBERO/src/database/repositories/bot-repository.ts).
//  - Sus arranques solo registran el username, no el ID (CERBERO/src/bot.ts).
//  - Consultar `getMe`/`getChatAdministrators` de CERBERO exigiría llamadas a
//    Telegram desde ZEUS o usar el token de CERBERO: ambos descartados.
// Por eso la protección se mantiene basada en el ID numérico configurado y
// verificado manualmente por el operador contra el username real. NO se
// introduce ninguna comprobación ficticia. Único control local de coherencia
// implementado (real, sin suposiciones): avisar si el ID configurado para
// CERBERO coincide con una identidad administrativa de usuario, algo
// imposible en Telegram porque cuentas de usuario y bots no comparten ID y
// que indicaría un valor pegado por error.

/**
 * Diagnóstico de la protección de bots para el arranque.
 * Contiene solo estados y recuentos: sin tokens, credenciales ni IDs.
 */
export interface ServiceBotProtectionDiagnostic {
  /** ACTIVA = la expulsión automática de bots no autorizados está armada. */
  botProtection: "ACTIVA" | "DESACTIVADA";
  cerbero: "CONFIGURADO" | "PENDIENTE";
  /** IDs configurados (CERBERO + extras), deduplicados. ZEUS no se cuenta:
   *  su identidad se resuelve en tiempo de ejecución con `ctx.me.id`. */
  authorizedBots: number;
  /** Entradas de SECURITY_EXTRA_BOT_IDS descartadas por ser inválidas. */
  invalidExtraBotIds: number;
}

export function getServiceBotProtectionDiagnostic(): ServiceBotProtectionDiagnostic {
  return {
    botProtection: pendingServiceBotLabels().length > 0 ? "DESACTIVADA" : "ACTIVA",
    cerbero: CERBERO_BOT_ID === undefined ? "PENDIENTE" : "CONFIGURADO",
    authorizedBots: allowedServiceBotIds().length,
    invalidExtraBotIds: INVALID_EXTRA_BOT_ID_ENTRIES.length,
  };
}

/**
 * Advertencias de configuración listas para registrar al arrancar.
 * Solo exponen posición, longitud y motivo: jamás el valor original.
 * `cerberoId` es inyectable para poder probar el caso de colisión.
 */
export function getServiceBotConfigWarnings(
  cerberoId: number | undefined = CERBERO_BOT_ID,
): string[] {
  const warnings: string[] = INVALID_EXTRA_BOT_ID_ENTRIES.map(
    (entry) =>
      `SECURITY_EXTRA_BOT_IDS: entrada #${entry.index} descartada ` +
      `(longitud=${entry.length}, motivo=${entry.reason}). ` +
      "Usa solo IDs numéricos positivos de Telegram separados por comas.",
  );
  if (cerberoId !== undefined && isConfiguredAdminId(cerberoId)) {
    warnings.push(
      "CERBERO_TELEGRAM_BOT_ID coincide con una identidad administrativa de " +
        "usuario; revisa que hayas pegado el ID numérico del bot y no el de " +
        "una cuenta personal.",
    );
  }
  return warnings;
}

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
