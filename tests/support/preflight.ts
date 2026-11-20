import {
  addBindingEntry,
  readBindingJournal,
  removeBindingEntry,
  writeBindingJournal,
  type BindingJournal,
  type BindingJournalEntry,
} from "./binding-journal.js";
import {
  classifySuiteError,
  describeSuiteError,
  type PgErrorLike,
  type SuiteDb,
} from "./suite-db.js";
import { SECURITY_COMMAND_RETRY_SUFFIX } from "../../src/services/security-command-recovery.js";

/**
 * Preflight de aislamiento, recuperación de residuos, limpieza verificada y
 * restauración de bindings de la suite PostgreSQL (Fase 4C, §2–§6).
 *
 * Todo el módulo es independiente de `@supabase/supabase-js`: recibe un
 * `SuiteDb` y devuelve informes. Así las reglas se prueban sin PostgreSQL
 * (`tests/postgres-suite-guard.test.ts`) y la suite de integración usa el
 * adaptador real (`tests/support/suite-db.ts`).
 *
 * Principio: cualquier comprobación que no se pueda completar es un BLOQUEO, no
 * una omisión silenciosa. Ninguna escritura ocurre antes de que el preflight
 * inicial decida `ok`.
 */

/** Prefijo inequívoco de toda fila creada por la suite. */
export const TEST_OPERATION_KEY_PREFIX = "zeus-it-";

/** `RUN_MARKER` con forma verificable (prefijo + 8 hex). */
export const RUN_MARKER_PATTERN = /^zeus-it-[0-9a-f]{8}$/;

/** Ventana de latido de CERBERO (`claim_security_command`, 011): 2 minutos. */
export const RECENT_HEARTBEAT_WINDOW_MS = 2 * 60_000;

/** `action` del espejo que escribe la RPC 021. */
export const MIRROR_ACTION = "security_command_requeue";
/** Tipo de evento obligatorio que escribe la RPC 021. */
export const REQUEUE_EVENT_TYPE = "security_command_requeued";
/** Tabla espejo y su nombre temporal en el escenario de renombrado. */
export const MIRROR_TABLE = "security_audit_log";
export const MIRROR_BACKUP_TABLE = "security_audit_log_zeus_test_backup";

export interface SuiteSubject {
  groupId: number;
  operatorId: number;
  runMarker: string;
  /** `instance_id` del bot de pruebas (`zeus-integration-test`). */
  testInstanceId: string;
  testBotName: string;
  testBotType: string;
  markerTable: string;
  /** Ruta del diario persistente de bindings. */
  journalPath: string;
}

export interface ResidualRow {
  id: string;
  group_id: number | string | null;
  operation_key: string | null;
  status: string | null;
  lease_expires_at: string | null;
}

export interface BotRow {
  id: string;
  instance_id?: string | null;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  last_heartbeat_at?: string | null;
}

export interface BindingRow {
  bot_id: string;
  enabled?: boolean | null;
}

/** Bot con actividad reciente: no puede haber ningún worker vivo. */
export function isLiveBot(
  bot: BotRow,
  now: number = Date.now(),
): boolean {
  const heartbeat = bot.last_heartbeat_at ? Date.parse(bot.last_heartbeat_at) : NaN;
  if (Number.isFinite(heartbeat) && heartbeat > now - RECENT_HEARTBEAT_WINDOW_MS) {
    return true;
  }
  const status = (bot.status ?? "").trim();
  return status === "online" || status === "running";
}

/** Lease vigente: la fila puede seguir siendo propiedad de otro proceso. */
export function isLiveLease(
  row: ResidualRow,
  now: number = Date.now(),
): boolean {
  if ((row.status ?? "").trim() !== "processing") return false;
  if (!row.lease_expires_at) return false;
  const expires = Date.parse(row.lease_expires_at);
  return Number.isFinite(expires) ? expires > now : false;
}

/** Fila atribuible a la suite por su prefijo de clave de operación. */
export function isAttributableTestRow(row: { operation_key: string | null }): boolean {
  return (
    typeof row.operation_key === "string" &&
    row.operation_key.startsWith(TEST_OPERATION_KEY_PREFIX)
  );
}

export interface Probe<TRow> {
  rows: TRow[] | null;
  error: string | null;
}

export interface CountProbe {
  count: number | null;
  error: string | null;
}

export interface PreflightFacts {
  now: number;
  marker: CountProbe;
  commands: CountProbe;
  /** Todas las filas con prefijo de pruebas, de CUALQUIER grupo. */
  residuals: Probe<ResidualRow>;
  bots: Probe<BotRow>;
  bindings: Probe<BindingRow>;
  testBots: Probe<BotRow>;
}

function describeOrNull(error: PgErrorLike | null | undefined): string | null {
  return error ? describeSuiteError(error) : null;
}

/**
 * Lecturas del preflight. Sólo lee: ninguna escritura ocurre aquí.
 *
 * Cada sonda captura su error por separado para que el veredicto pueda nombrar
 * qué comprobación falló (y no confundir "no hay filas" con "no se pudo leer").
 */
export async function observePreflight(
  db: SuiteDb,
  subject: SuiteSubject,
  now: number = Date.now(),
): Promise<PreflightFacts> {
  const marker = await db.count(subject.markerTable);
  const commands = await db.count("security_commands");
  const residuals = await db.select<ResidualRow>("security_commands", {
    columns: "id,group_id,operation_key,status,lease_expires_at",
    filters: [
      { op: "like", column: "operation_key", pattern: `${TEST_OPERATION_KEY_PREFIX}%` },
    ],
  });
  const bots = await db.select<BotRow>("bots", {
    columns: "id,instance_id,name,type,status,last_heartbeat_at",
  });
  const bindings = await db.select<BindingRow>("group_bot_bindings", {
    columns: "bot_id,enabled",
    filters: [{ op: "eq", column: "group_id", value: subject.groupId }],
  });
  const testBots = await db.select<BotRow>("bots", {
    columns: "id,instance_id,name,type,last_heartbeat_at",
    filters: [{ op: "eq", column: "instance_id", value: subject.testInstanceId }],
  });

  return {
    now,
    marker: { count: marker.count, error: describeOrNull(marker.error) },
    commands: { count: commands.count, error: describeOrNull(commands.error) },
    residuals: {
      rows: residuals.data,
      error: describeOrNull(residuals.error),
    },
    bots: { rows: bots.data, error: describeOrNull(bots.error) },
    bindings: { rows: bindings.data, error: describeOrNull(bindings.error) },
    testBots: { rows: testBots.data, error: describeOrNull(testBots.error) },
  };
}

function toGroupKey(value: number | string | null): string {
  return value === null || value === undefined ? "" : String(value);
}

export type PreflightPhase = "initial" | "post-recovery";

export interface PreflightVerdict {
  ok: boolean;
  blockers: string[];
  diagnostics: string[];
  /** Residuos en el grupo, atribuibles y sin lease vigente: recuperables. */
  attributableResiduals: ResidualRow[];
  /** Id del bot del entorno de pruebas (null si no se pudo verificar). */
  testBotId: string | null;
}

/**
 * Decide si el entorno es exclusivo para la suite (§2).
 *
 * `phase: "initial"` permite residuos atribuibles (los eliminará la
 * recuperación); `phase: "post-recovery"` los convierte en bloqueo, porque ya
 * deberían haber desaparecido.
 */
export function decidePreflight(
  facts: PreflightFacts,
  subject: SuiteSubject,
  phase: PreflightPhase = "initial",
): PreflightVerdict {
  const blockers: string[] = [];
  const diagnostics: string[] = [];
  const attributable: ResidualRow[] = [];

  // 1. Marcador del proyecto desechable (§2: exigir el marcador).
  if (facts.marker.error) {
    blockers.push(
      `marcador ${subject.markerTable} no comprobable: ${facts.marker.error}`,
    );
  } else if (!facts.marker.count || facts.marker.count < 1) {
    blockers.push(
      `el marcador ${subject.markerTable} está vacío: el proyecto no está declarado como desechable`,
    );
  }

  // 2. Partición de residuos (alimenta la vaciedad y la fase de recuperación).
  //    Sólo se consideran de la suite las filas del grupo fixture cuyo prefijo de
  //    clave de operación es inequívoco. Todo lo demás es ambigüedad → bloqueo.
  const residualRows = facts.residuals.error ? [] : (facts.residuals.rows ?? []);
  const foreignResiduals = residualRows.filter(
    (row) => toGroupKey(row.group_id) !== String(subject.groupId),
  );
  const inGroupResiduals = residualRows.filter(
    (row) => toGroupKey(row.group_id) === String(subject.groupId),
  );
  const liveResiduals = inGroupResiduals.filter((row) => isLiveLease(row, facts.now));
  const attributableRows = inGroupResiduals.filter(
    (row) => !isLiveLease(row, facts.now) && isAttributableTestRow(row),
  );
  const unattributableResiduals = inGroupResiduals.filter(
    (row) => !isLiveLease(row, facts.now) && !isAttributableTestRow(row),
  );
  const recoverable = phase === "initial" ? attributableRows.length : 0;

  // 3. Vaciedad de security_commands (§2), descontando lo que la recuperación
  //    va a borrar. Tras la recuperación el recuento debe ser exactamente 0.
  if (facts.commands.error) {
    blockers.push(`no se puede leer security_commands: ${facts.commands.error}`);
  } else if ((facts.commands.count ?? 0) - recoverable !== 0) {
    const remaining = (facts.commands.count ?? 0) - recoverable;
    blockers.push(
      `el proyecto no es exclusivo para pruebas: security_commands tiene ${remaining} ` +
        "fila(s) que no son residuos atribuibles de esta suite (se exige 0 antes de empezar)",
    );
  }

  // 4. Residuos de ejecuciones anteriores, con atribución verificable (§3).
  if (facts.residuals.error) {
    blockers.push(`no se pueden leer residuos de pruebas: ${facts.residuals.error}`);
  } else {
    if (foreignResiduals.length > 0) {
      blockers.push(
        `${foreignResiduals.length} orden(es) con prefijo de pruebas pertenecen a OTRO grupo: no se borran ` +
          "automáticamente (propiedad ambigua) y la suite no puede empezar",
      );
    }
    if (liveResiduals.length > 0) {
      blockers.push(
        `${liveResiduals.length} orden(es) de pruebas tienen lease vigente: otro proceso podría estar ` +
          "ejecutándolas; no se borran y la suite no puede empezar",
      );
    }
    if (unattributableResiduals.length > 0) {
      blockers.push(
        `${unattributableResiduals.length} orden(es) del grupo no son atribuibles con certeza a la suite: ` +
          "no se borran automáticamente",
      );
    }
    if (attributableRows.length > 0) {
      if (phase === "initial") {
        diagnostics.push(
          `${attributableRows.length} orden(es) residuales de ejecuciones anteriores: se eliminarán antes de empezar`,
        );
        attributable.push(...attributableRows);
      } else {
        blockers.push(
          `${attributableRows.length} orden(es) residuales siguen presentes tras la recuperación`,
        );
      }
    }
  }

  // 4. Ningún bot con actividad reciente (§2).
  if (facts.bots.error) {
    blockers.push(`no se puede leer bots: ${facts.bots.error}`);
  } else {
    const live = (facts.bots.rows ?? []).filter((bot) => isLiveBot(bot, facts.now));
    if (live.length > 0) {
      blockers.push(
        `${live.length} bot(s) con heartbeat reciente (o estado online): un worker vivo podría ` +
          "reclamar las órdenes de la prueba",
      );
    }
  }

  // 5. Bot del entorno de pruebas: exactamente uno y con el tipo esperado.
  let testBotId: string | null = null;
  if (facts.testBots.error) {
    blockers.push(
      `no se puede verificar el bot del entorno de pruebas (instance_id=${subject.testInstanceId}): ` +
        facts.testBots.error,
    );
  } else {
    const bots = facts.testBots.rows ?? [];
    if (bots.length !== 1) {
      blockers.push(
        `se esperaba exactamente un bot con instance_id=${subject.testInstanceId}; hay ${bots.length}`,
      );
    } else {
      testBotId = bots[0].id;
      if (
        (bots[0].name ?? "") !== subject.testBotName ||
        (bots[0].type ?? "") !== subject.testBotType
      ) {
        blockers.push(
          `el bot del entorno de pruebas debe ser name=${subject.testBotName} y type=${subject.testBotType}`,
        );
      }
    }
  }

  // 6. Los bindings del grupo fixture deben ser EXCLUSIVAMENTE del entorno de
  //    pruebas (§2, §4): nunca se deshabilitan bindings de bots ajenos.
  if (facts.bindings.error) {
    blockers.push(`no se pueden leer group_bot_bindings: ${facts.bindings.error}`);
  } else {
    const bindings = facts.bindings.rows ?? [];
    if (bindings.length === 0) {
      blockers.push(
        `el grupo fixture ${subject.groupId} no tiene bindings: no se puede verificar el aislamiento`,
      );
    }
    if (testBotId) {
      const foreign = bindings.filter((binding) => binding.bot_id !== testBotId);
      if (foreign.length > 0) {
        blockers.push(
          `${foreign.length} binding(s) del grupo fixture apuntan a bots que no son del entorno de ` +
            "pruebas: la suite no deshabilita bindings ajenos y no puede empezar",
        );
      }
    }
    if (bindings.length > 0 && !bindings.some((binding) => binding.enabled !== false)) {
      blockers.push(
        "el grupo fixture no tiene ningún binding habilitado: los reencolados responderían " +
          "group_not_eligible y claim_security_command no reclamaría nada",
      );
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    diagnostics,
    attributableResiduals: attributable,
    testBotId,
  };
}

/** Prefijo `%zeus-it-%` usado para atribuir filas de eventos y espejo. */
const RUN_MARKER_LIKE = `%${TEST_OPERATION_KEY_PREFIX}%`;

export interface ResidualRecoveryReport {
  deletedCommands: number;
  deletedEvents: number;
  deletedMirrorRows: number;
  blockers: string[];
  diagnostics: string[];
}

/**
 * Recupera residuos de ejecuciones anteriores (§3).
 *
 * Sólo se ejecuta después de que el preflight haya verificado el entorno
 * exclusivo, y sólo borra filas atribuibles con certeza:
 *  - órdenes del grupo fixture cuya `operation_key` empieza por `zeus-it-`;
 *  - eventos `security_command_requeued` de ese grupo cuyo `details.reason`
 *    contiene el prefijo (sólo la suite escribe ese motivo);
 *  - filas del espejo con `action='security_command_requeue'` y `result` con el
 *    prefijo de pruebas.
 *
 * Nunca borra por `group_id` a secas, nunca toca otros grupos y no adivina la
 * propiedad de una fila: si no puede atribuirla, el preflight ya la ha
 * convertido en bloqueo y este método no llega a ejecutarse.
 */
export async function recoverResiduals(
  db: SuiteDb,
  subject: SuiteSubject,
  rows: readonly ResidualRow[],
): Promise<ResidualRecoveryReport> {
  const report: ResidualRecoveryReport = {
    deletedCommands: 0,
    deletedEvents: 0,
    deletedMirrorRows: 0,
    blockers: [],
    diagnostics: [],
  };

  const ids = rows
    .filter((row) => isAttributableTestRow(row))
    .map((row) => String(row.id));
  if (ids.length === 0) return report;

  // 1. Espejo (FK `command_id -> security_commands on delete set null`).
  const mirror = await db.delete(MIRROR_TABLE, [
    { op: "eq", column: "group_id", value: subject.groupId },
    { op: "eq", column: "action", value: MIRROR_ACTION },
    { op: "like", column: "result", pattern: RUN_MARKER_LIKE },
  ]);
  if (mirror.error) {
    if (classifySuiteError(mirror.error) === "missing_table") {
      report.diagnostics.push(
        `${MIRROR_TABLE} no existe en el proyecto: no hay espejo que recuperar (tabla opcional)`,
      );
    } else {
      report.blockers.push(
        `no se pudieron recuperar filas del espejo: ${describeSuiteError(mirror.error)}`,
      );
      return report;
    }
  } else {
    report.deletedMirrorRows = mirror.data?.length ?? 0;
  }

  // 2. Eventos de auditoría obligatorios.
  const events = await db.select<{ id: string }>("security_events", {
    columns: "id",
    filters: [
      { op: "eq", column: "group_id", value: subject.groupId },
      { op: "eq", column: "event_type", value: REQUEUE_EVENT_TYPE },
      { op: "json", column: "details", path: "reason", compare: "like", value: RUN_MARKER_LIKE },
    ],
  });
  if (events.error) {
    report.blockers.push(
      `no se pudieron localizar eventos residuales: ${describeSuiteError(events.error)}`,
    );
    return report;
  }
  const eventIds = (events.data ?? []).map((row) => String(row.id));
  if (eventIds.length > 0) {
    const deleted = await db.delete("security_events", [
      { op: "in", column: "id", values: eventIds },
    ]);
    if (deleted.error) {
      report.blockers.push(
        `no se pudieron borrar eventos residuales: ${describeSuiteError(deleted.error)}`,
      );
      return report;
    }
    const removed = deleted.data?.length ?? 0;
    if (removed !== eventIds.length) {
      report.blockers.push(
        `se borraron ${removed} de ${eventIds.length} eventos residuales: hay un escritor concurrente`,
      );
      return report;
    }
    report.deletedEvents = removed;
  }

  // 3. Órdenes: por id exacto, verificando cuántas se borraron.
  const deletedCommands = await db.delete("security_commands", [
    { op: "in", column: "id", values: ids },
  ]);
  if (deletedCommands.error) {
    report.blockers.push(
      `no se pudieron borrar órdenes residuales: ${describeSuiteError(deletedCommands.error)}`,
    );
    return report;
  }
  const removedCommands = deletedCommands.data?.length ?? 0;
  if (removedCommands !== ids.length) {
    report.blockers.push(
      `se borraron ${removedCommands} de ${ids.length} órdenes residuales: hay un escritor concurrente`,
    );
    return report;
  }
  report.deletedCommands = removedCommands;
  return report;
}

export interface FixtureRef {
  id: string;
  operationKey: string;
}

export interface CleanupReport {
  blockers: string[];
  diagnostics: string[];
  /** Filas que siguen existiendo después de la limpieza (de esta ejecución). */
  residue: string[];
  deleted: { mirror: number; events: number; retries: number; originals: number };
}

function emptyCleanupReport(): CleanupReport {
  return {
    blockers: [],
    diagnostics: [],
    residue: [],
    deleted: { mirror: 0, events: 0, retries: 0, originals: 0 },
  };
}

/**
 * Limpieza verificada de las filas de un fixture (§5).
 *
 * Cada bloque distingue:
 *  - tabla opcional ausente (`security_audit_log`): diagnóstico, no error;
 *  - columna ausente (`42703`): BLOQUEO con la causa (hallazgo B6: antes se
 *    toleraba como si la tabla no existiera);
 *  - permisos, conexión y errores de borrado: BLOQUEO con clasificación.
 *
 * Orden: espejo → eventos → reintentos → original. El espejo va primero porque
 * su FK es `command_id -> security_commands on delete set null`; los eventos van
 * después porque `security_events` no referencia a `security_commands`.
 *
 * Se borra por id exacto (nunca por `group_id` a secas) y se verifica el número
 * de filas borradas: si la fila ya no existía, no es un error (recuperación
 * tras una interrupción); si desapareció ENTRE la lectura y el borrado, sí.
 */
export async function cleanupFixtures(
  db: SuiteDb,
  subject: SuiteSubject,
  fixtures: readonly FixtureRef[],
): Promise<CleanupReport> {
  const report = emptyCleanupReport();

  for (const fixture of fixtures) {
    const retryKey = `${fixture.operationKey}${SECURITY_COMMAND_RETRY_SUFFIX}`;

    const retries = await db.select<{ id: string }>("security_commands", {
      columns: "id",
      filters: [
        { op: "eq", column: "group_id", value: subject.groupId },
        { op: "eq", column: "operation_key", value: retryKey },
      ],
    });
    if (retries.error) {
      report.blockers.push(
        `no se pueden localizar los reintentos de ${fixture.id}: ${describeSuiteError(retries.error)}`,
      );
      continue;
    }
    const retryIds = (retries.data ?? []).map((row) => String(row.id));
    const candidateIds = [fixture.id, ...retryIds];

    const existing = await db.select<{ id: string }>("security_commands", {
      columns: "id",
      filters: [{ op: "in", column: "id", values: candidateIds }],
    });
    if (existing.error) {
      report.blockers.push(
        `no se pueden confirmar las órdenes de ${fixture.id}: ${describeSuiteError(existing.error)}`,
      );
      continue;
    }
    const existingIds = (existing.data ?? []).map((row) => String(row.id));
    const existingRetryIds = retryIds.filter((id) => existingIds.includes(id));

    // 1. Espejo.
    if (existingIds.length > 0) {
      const mirror = await db.delete(MIRROR_TABLE, [
        { op: "in", column: "command_id", values: existingIds },
        { op: "eq", column: "action", value: MIRROR_ACTION },
        { op: "like", column: "result", pattern: `%${subject.runMarker}%` },
      ]);
      if (mirror.error) {
        if (classifySuiteError(mirror.error) === "missing_table") {
          report.diagnostics.push(
            `${MIRROR_TABLE} ausente: espejo opcional, no hay filas que borrar`,
          );
        } else {
          report.blockers.push(
            `no se pudo borrar el espejo de ${fixture.id}: ${describeSuiteError(mirror.error)}`,
          );
        }
      } else {
        report.deleted.mirror += mirror.data?.length ?? 0;
      }
    }

    // 2. Eventos obligatorios del fixture (por `details.originalCommandId`).
    const events = await db.select<{ id: string }>("security_events", {
      columns: "id",
      filters: [
        { op: "eq", column: "group_id", value: subject.groupId },
        { op: "eq", column: "event_type", value: REQUEUE_EVENT_TYPE },
        {
          op: "json",
          column: "details",
          path: "originalCommandId",
          compare: "eq",
          value: fixture.id,
        },
      ],
    });
    if (events.error) {
      report.blockers.push(
        `no se pudieron localizar eventos de ${fixture.id}: ${describeSuiteError(events.error)}`,
      );
    } else {
      const eventIds = (events.data ?? []).map((row) => String(row.id));
      if (eventIds.length > 0) {
        const deleted = await db.delete("security_events", [
          { op: "in", column: "id", values: eventIds },
        ]);
        if (deleted.error) {
          report.blockers.push(
            `no se pudieron borrar eventos de ${fixture.id}: ${describeSuiteError(deleted.error)}`,
          );
        } else {
          const removed = deleted.data?.length ?? 0;
          if (removed !== eventIds.length) {
            report.blockers.push(
              `se borraron ${removed} de ${eventIds.length} eventos de ${fixture.id}`,
            );
          }
          report.deleted.events += removed;
        }
      }
    }

    // 3. Reintentos.
    if (existingRetryIds.length > 0) {
      const deleted = await db.delete("security_commands", [
        { op: "in", column: "id", values: existingRetryIds },
      ]);
      if (deleted.error) {
        report.blockers.push(
          `no se pudieron borrar los reintentos de ${fixture.id}: ${describeSuiteError(deleted.error)}`,
        );
      } else {
        const removed = deleted.data?.length ?? 0;
        if (removed !== existingRetryIds.length) {
          report.blockers.push(
            `se borraron ${removed} de ${existingRetryIds.length} reintentos de ${fixture.id}`,
          );
        }
        report.deleted.retries += removed;
      }
    }

    // 4. Orden original.
    if (existingIds.includes(fixture.id)) {
      const deleted = await db.delete("security_commands", [
        { op: "eq", column: "id", value: fixture.id },
        { op: "eq", column: "group_id", value: subject.groupId },
      ]);
      if (deleted.error) {
        report.blockers.push(
          `no se pudo borrar la orden ${fixture.id}: ${describeSuiteError(deleted.error)}`,
        );
      } else {
        const removed = deleted.data?.length ?? 0;
        if (removed !== 1) {
          report.blockers.push(
            `se esperaba borrar 1 orden original (${fixture.id}) y se borraron ${removed}`,
          );
        }
        report.deleted.originals += removed;
      }
    }

    // 5. Residuo de la clave completa (detecta un reintento creado en paralelo).
    const leftover = await db.count("security_commands", [
      { op: "eq", column: "group_id", value: subject.groupId },
      { op: "like", column: "operation_key", pattern: `${fixture.operationKey}%` },
    ]);
    if (leftover.error) {
      report.blockers.push(
        `no se puede verificar el residuo de ${fixture.operationKey}: ${describeSuiteError(leftover.error)}`,
      );
    } else if ((leftover.count ?? 0) > 0) {
      report.residue.push(
        `${leftover.count} orden(es) con la clave ${fixture.operationKey} siguen en la base`,
      );
    }
  }

  return report;
}

export interface DisarmReport {
  disabled: BindingJournalEntry[];
  blockers: string[];
  diagnostics: string[];
}

/**
 * Deshabilita los bindings del bot de pruebas registrando ANTES el estado
 * original en el diario persistente (§4).
 *
 * Nunca toca bindings de bots ajenos: sólo los `bot_id` recibidos, que el
 * preflight ha verificado como exclusivos del entorno de pruebas.
 */
export async function disarmTestBindings(
  db: SuiteDb,
  subject: SuiteSubject,
  botIds: readonly string[],
): Promise<DisarmReport> {
  const report: DisarmReport = { disabled: [], blockers: [], diagnostics: [] };

  if (botIds.length === 0) {
    report.blockers.push(
      "no se conoce el bot del entorno de pruebas: no se deshabilita ningún binding",
    );
    return report;
  }

  const loaded = readBindingJournal(subject.journalPath);
  if (!loaded.ok) {
    report.blockers.push(
      `no se puede leer el diario de bindings: ${loaded.detail} (no se deshabilita nada)`,
    );
    return report;
  }
  let journal: BindingJournal = loaded.journal;

  const bindings = await db.select<BindingRow>("group_bot_bindings", {
    columns: "bot_id,enabled",
    filters: [
      { op: "eq", column: "group_id", value: subject.groupId },
      { op: "is", column: "enabled", value: true },
      { op: "in", column: "bot_id", values: [...botIds] },
    ],
  });
  if (bindings.error) {
    report.blockers.push(
      `no se pueden leer los bindings a deshabilitar: ${describeSuiteError(bindings.error)}`,
    );
    return report;
  }
  const targets = bindings.data ?? [];
  if (targets.length === 0) {
    report.diagnostics.push(
      "no hay bindings habilitados del bot de pruebas que deshabilitar",
    );
    return report;
  }

  for (const target of targets) {
    const entry: BindingJournalEntry = {
      group_id: String(subject.groupId),
      bot_id: target.bot_id,
      previous_enabled: target.enabled !== false,
      disabled_at: new Date().toISOString(),
      run_marker: subject.runMarker,
    };

    // 1. Persistir el estado original ANTES de tocar la base.
    const updated = addBindingEntry(journal, entry);
    if (updated.added) {
      const written = writeBindingJournal(subject.journalPath, updated.journal);
      if (!written.ok) {
        report.blockers.push(
          `${written.detail}: no se deshabilita el binding ${target.bot_id} sin diario`,
        );
        return report;
      }
      journal = updated.journal;
    }

    // 2. Deshabilitar y verificar que afectó exactamente a esa fila.
    const disabled = await db.update("group_bot_bindings", { enabled: false }, [
      { op: "eq", column: "group_id", value: subject.groupId },
      { op: "eq", column: "bot_id", value: target.bot_id },
      { op: "is", column: "enabled", value: true },
    ]);
    if (disabled.error) {
      report.blockers.push(
        `no se pudo deshabilitar el binding ${target.bot_id}: ${describeSuiteError(disabled.error)}`,
      );
      return report;
    }
    const affected = disabled.data?.length ?? 0;
    if (affected !== 1) {
      report.blockers.push(
        `se esperaba deshabilitar 1 binding (${target.bot_id}) y se deshabilitaron ${affected}`,
      );
      return report;
    }
    report.disabled.push(entry);
  }

  return report;
}

export interface RestoreReport {
  restored: number;
  alreadyInOriginalState: number;
  pending: number;
  blockers: string[];
  diagnostics: string[];
}

/**
 * Restaura los bindings registrados en el diario y VERIFICA el resultado (§4).
 *
 * - no depende de un hook `finally`: el diario sobrevive a `kill -9`;
 * - una entrada sólo se retira cuando una lectura posterior confirma el estado
 *   original;
 * - un error de restauración es un bloqueo, nunca una omisión.
 */
export async function restoreTestBindings(
  db: SuiteDb,
  subject: SuiteSubject,
): Promise<RestoreReport> {
  const report: RestoreReport = {
    restored: 0,
    alreadyInOriginalState: 0,
    pending: 0,
    blockers: [],
    diagnostics: [],
  };

  const loaded = readBindingJournal(subject.journalPath);
  if (!loaded.ok) {
    report.blockers.push(`no se puede leer el diario de bindings: ${loaded.detail}`);
    return report;
  }
  let journal = loaded.journal;
  if (journal.entries.length === 0) return report;

  for (const entry of [...journal.entries]) {
    const current = await db.select<BindingRow>("group_bot_bindings", {
      columns: "bot_id,enabled",
      filters: [
        { op: "eq", column: "group_id", value: Number(entry.group_id) },
        { op: "eq", column: "bot_id", value: entry.bot_id },
      ],
    });
    if (current.error) {
      report.blockers.push(
        `no se puede leer el binding ${entry.bot_id}: ${describeSuiteError(current.error)}`,
      );
      report.pending += 1;
      continue;
    }
    const row = (current.data ?? [])[0];
    if (!row) {
      report.blockers.push(
        `el binding ${entry.bot_id} del grupo ${entry.group_id} ya no existe: ` +
          "revisar group_bot_bindings a mano y retirar la entrada del diario",
      );
      report.pending += 1;
      continue;
    }

    const target = entry.previous_enabled;
    if ((row.enabled !== false) === target) {
      // Ya está en el estado original: restaurado antes de morir o nunca cambiado.
      const removed = removeBindingEntry(journal, entry.group_id, entry.bot_id);
      if (removed.removed) {
        journal = removed.journal;
        const written = writeBindingJournal(subject.journalPath, journal);
        if (!written.ok) report.blockers.push(written.detail);
      }
      report.alreadyInOriginalState += 1;
      continue;
    }

    const updated = await db.update("group_bot_bindings", { enabled: target }, [
      { op: "eq", column: "group_id", value: Number(entry.group_id) },
      { op: "eq", column: "bot_id", value: entry.bot_id },
    ]);
    if (updated.error) {
      report.blockers.push(
        `no se pudo restaurar el binding ${entry.bot_id}: ${describeSuiteError(updated.error)}`,
      );
      report.pending += 1;
      continue;
    }
    const affected = updated.data?.length ?? 0;
    if (affected !== 1) {
      report.blockers.push(
        `se esperaba restaurar 1 binding (${entry.bot_id}) y se actualizaron ${affected}`,
      );
      report.pending += 1;
      continue;
    }

    // Verificación independiente: releer y comparar con el estado original.
    const verify = await db.select<BindingRow>("group_bot_bindings", {
      columns: "bot_id,enabled",
      filters: [
        { op: "eq", column: "group_id", value: Number(entry.group_id) },
        { op: "eq", column: "bot_id", value: entry.bot_id },
      ],
    });
    if (verify.error) {
      report.blockers.push(
        `no se puede verificar la restauración de ${entry.bot_id}: ${describeSuiteError(verify.error)}`,
      );
      report.pending += 1;
      continue;
    }
    const verified = (verify.data ?? [])[0];
    if (!verified || (verified.enabled !== false) !== target) {
      report.blockers.push(
        `la restauración de ${entry.bot_id} no quedó aplicada (estado distinto del original)`,
      );
      report.pending += 1;
      continue;
    }

    journal = removeBindingEntry(journal, entry.group_id, entry.bot_id).journal;
    const written = writeBindingJournal(subject.journalPath, journal);
    if (!written.ok) {
      report.blockers.push(written.detail);
      report.pending += 1;
      continue;
    }
    report.restored += 1;
  }

  return report;
}

/** Escenarios mutuamente excluyentes de la prueba del espejo (§6). */
export type MirrorScenario = "default" | "audit-log-rename";

/** Sentencia exacta de restauración que se muestra si el espejo quedó renombrado. */
export const MIRROR_RESTORE_STATEMENT =
  `alter table public.${MIRROR_BACKUP_TABLE} rename to ${MIRROR_TABLE};`;

/**
 * Valida `ZEUS_TEST_SCENARIO`. Cualquier valor desconocido es un bloqueo: un
 * escenario mal escrito no puede degradar silenciosamente la cobertura.
 */
export function parseMirrorScenario(
  raw: string | undefined,
): { ok: true; scenario: MirrorScenario } | { ok: false; detail: string } {
  const value = (raw ?? "").trim();
  if (value === "" || value === "default") return { ok: true, scenario: "default" };
  if (value === "audit-log-rename") return { ok: true, scenario: "audit-log-rename" };
  return {
    ok: false,
    detail:
      `ZEUS_TEST_SCENARIO='${value}' no es válido: usar 'default' o 'audit-log-rename'`,
  };
}

export interface MirrorProbe {
  /** `true` si la tabla existe; `false` si no existe o no se pudo comprobar. */
  present: boolean;
  /** `null` cuando la comprobación se completó (exista o no la tabla). */
  error: string | null;
}

/** Convierte el resultado de una sonda en `MirrorProbe`. */
export function toMirrorProbe(result: { error: PgErrorLike | null }): MirrorProbe {
  if (!result.error) return { present: true, error: null };
  if (classifySuiteError(result.error) === "missing_table") {
    return { present: false, error: null };
  }
  return { present: false, error: describeSuiteError(result.error) };
}

export interface MirrorStateInput {
  scenario: MirrorScenario;
  main: MirrorProbe;
  backup: MirrorProbe;
}

export interface MirrorVerdict {
  blockers: string[];
  diagnostics: string[];
  /** `true` sólo si la prueba de renombrado debe ejecutarse en esta corrida. */
  runRenameScenario: boolean;
  /** Motivo de omisión de la prueba de renombrado (nunca de la de higiene). */
  skipReason: string | null;
}

/**
 * Resuelve la contradicción M3 (§6).
 *
 * Dato que condiciona el diseño: PostgREST no ejecuta DDL, así que la suite NO
 * puede renombrar `security_audit_log`. El renombrado lo prepara y lo restaura
 * el operador; la suite sólo verifica el estado esperado en cada escenario.
 *
 * Antes: la prueba que exige que el espejo NO exista se omitía siempre que la
 * tabla existiera (es decir, siempre), mientras la prueba de higiene fallaba si
 * existía `security_audit_log_zeus_test_backup`. En una corrida verde la primera
 * no se ejecutaba nunca y la segunda no podía pasar junto con ella.
 *
 * Ahora el escenario es explícito (`ZEUS_TEST_SCENARIO`):
 *  - `default`: se exige el estado normal. Un backup preexistente es un bloqueo
 *    (renombrado pendiente de una ejecución anterior) con la sentencia exacta de
 *    restauración. La prueba de renombrado se omite con instrucciones.
 *  - `audit-log-rename`: se exige el estado PREPARADO (`security_audit_log`
 *    ausente y backup presente). La prueba de renombrado se ejecuta y las
 *    comprobaciones de higiene que asumen el espejo presente se omiten; al
 *    terminar, el operador restaura con la sentencia indicada.
 */
export function evaluateMirrorState(input: MirrorStateInput): MirrorVerdict {
  const blockers: string[] = [];
  const diagnostics: string[] = [];
  let runRenameScenario = false;
  let skipReason: string | null = null;

  if (input.main.error) {
    blockers.push(`no se puede comprobar ${MIRROR_TABLE}: ${input.main.error}`);
  }
  if (input.backup.error) {
    blockers.push(
      `no se puede comprobar ${MIRROR_BACKUP_TABLE}: ${input.backup.error}`,
    );
  }

  if (input.scenario === "audit-log-rename") {
    if (input.main.present) {
      blockers.push(
        `el escenario 'audit-log-rename' exige que ${MIRROR_TABLE} NO exista: ` +
          `renombrarla antes de ejecutar (\`alter table public.${MIRROR_TABLE} rename to ${MIRROR_BACKUP_TABLE};\`)`,
      );
    } else if (!input.backup.present) {
      blockers.push(
        `el escenario 'audit-log-rename' exige el estado preparado: ${MIRROR_TABLE} ausente y ` +
          `${MIRROR_BACKUP_TABLE} presente (ver tests/README.md)`,
      );
    } else {
      runRenameScenario = true;
      diagnostics.push(
        `escenario preparado: ${MIRROR_TABLE} ausente y ${MIRROR_BACKUP_TABLE} presente. ` +
          `Al terminar, restaurar con \`${MIRROR_RESTORE_STATEMENT}\``,
      );
    }
  } else {
    if (input.backup.present) {
      blockers.push(
        `${MIRROR_BACKUP_TABLE} existe: una ejecución anterior dejó el espejo renombrado. ` +
          `Restaurar con \`${MIRROR_RESTORE_STATEMENT}\` antes de volver a ejecutar la suite`,
      );
    }
    if (!input.main.present && !input.backup.present) {
      diagnostics.push(
        `${MIRROR_TABLE} no existe en el proyecto: el espejo es opcional y las pruebas lo toleran`,
      );
    }
    skipReason =
      "escenario del espejo no seleccionado: preparar el estado con " +
      "ZEUS_TEST_SCENARIO=audit-log-rename para la prueba que requiere el espejo ausente " +
      "(ver tests/README.md)";
  }

  return {
    blockers,
    diagnostics,
    runRenameScenario: runRenameScenario && blockers.length === 0,
    skipReason,
  };
}










