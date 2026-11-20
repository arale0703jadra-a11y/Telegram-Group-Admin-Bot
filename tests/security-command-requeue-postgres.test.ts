import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  SecurityAction,
  SecurityCommandPayload,
  SecurityCommandResultState,
} from "../src/services/security-commands.js";
import {
  MUTE_MIN_REMAINING_MS,
  evaluateSecurityCommandReplayPolicy,
} from "../src/services/security-command-recovery.js";
import {
  cleanupFixtures,
  decidePreflight,
  disarmTestBindings,
  evaluateMirrorState,
  MIRROR_BACKUP_TABLE,
  MIRROR_RESTORE_STATEMENT,
  MIRROR_TABLE,
  parseMirrorScenario,
  recoverResiduals,
  restoreTestBindings,
  observePreflight,
  RUN_MARKER_PATTERN,
  toMirrorProbe,
  type CleanupReport,
  type FixtureRef,
  type MirrorProbe,
  type MirrorScenario,
  type MirrorVerdict,
  type SuiteSubject,
} from "./support/preflight.js";
import {
  loadProtectedRefInventory,
  evaluateStaticConfig,
  PROTECTED_REFS_INVENTORY_PATH,
} from "./support/project-refs.js";
import { createSupabaseSuiteDb, type SuiteDb } from "./support/suite-db.js";

/**
 * PRUEBAS DE INTEGRACIÓN — requieren un PostgreSQL real (vía Supabase) y están
 * deshabilitadas por defecto. Documentación operativa: `tests/README.md`.
 *
 * Endurecimiento de la Fase 4C (sobre los hallazgos de la Fase 4B):
 *
 *  1. REFERENCIAS PROTEGIDAS. El inventario `tests/fixtures/protected-project-refs.json`
 *     sustituye a la lista codificada de un solo elemento. Si el inventario no se
 *     puede leer o no es válido, la suite falla cerrado. Una referencia que no
 *     aparece en el inventario NO se considera segura por omisión: sólo es
 *     candidata, y la autorización sigue dependiendo del marcador y del preflight.
 *
 *  2. PREFLIGHT DE AISLAMIENTO (`tests/support/preflight.ts`), antes de cualquier
 *     escritura: marcador presente, `security_commands` sin filas ajenas, ningún
 *     bot con heartbeat reciente, un único bot `Cerbero`/`security` con
 *     `instance_id = zeus-integration-test`, y TODOS los bindings del grupo
 *     apuntando a ese bot. Cualquier comprobación que no se pueda completar
 *     detiene la suite: nunca se degrada a "omitir y seguir".
 *
 *  3. RECUPERACIÓN DE RESIDUOS. Toda fila de la suite usa el prefijo
 *     `zeus-it-`. Antes de empezar (y sólo si el preflight pasó) se borran las
 *     órdenes, eventos y filas de espejo atribuibles a ejecuciones anteriores. No
 *     se borra nada de otros grupos ni nada cuya propiedad sea ambigua (lease
 *     vigente): en ese caso la suite se detiene con un diagnóstico.
 *
 *  4. BINDINGS. El estado original se guarda en un diario persistente
 *     (`tests/.artifacts/bindings-journal.json`) ANTES de deshabilitar, y la
 *     restauración se verifica releyendo la fila. Un error de restauración es un
 *     fallo, nunca una omisión, y sobrevive a `kill -9`.
 *
 *  5. LIMPIEZA VERIFICADA. Espejo → eventos → reintentos → orden original, cada
 *     borrado comprobado, distinguiendo tabla opcional ausente, columna ausente,
 *     permisos, conexión y error de borrado. Los residuos se reportan y fallan.
 *
 *  6. ESCENARIO DEL ESPEJO (`ZEUS_TEST_SCENARIO`). `default` exige el espejo
 *     presente y ningún backup; `audit-log-rename` exige el estado preparado
 *     (espejo ausente + backup presente) y ejecuta la prueba que antes se omitía
 *     siempre. Las dos comprobaciones ya no se contradicen (hallazgo M3).
 *
 * Condiciones para ejecutarse:
 *   ZEUS_TEST_SUPABASE_URL=https://<proyecto-desechable>.supabase.co
 *   ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY=<service_role legacy (JWT), role=service_role>
 *   ZEUS_TEST_SUPABASE_DISPOSABLE=yes
 *   ZEUS_TEST_GROUP_ID=<chat_id de un grupo fixture existente>
 *   ZEUS_TEST_OPERATOR_ID=<id numérico del operador de prueba>
 *   ZEUS_TEST_SCENARIO=default|audit-log-rename   (opcional)
 *
 * Nunca se usan `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` como respaldo, y si
 * coinciden con las variables de prueba se bloquea la ejecución.
 *
 * Qué demuestra (y qué no puede demostrar una prueba unitaria):
 *   - el bloqueo `FOR UPDATE` serializa dos reencolados concurrentes,
 *   - el índice único `security_commands_operation_key_idx` existe y actúa,
 *   - la neutralización de la original ocurre en la misma transacción,
 *   - la auditoría se escribe sólo cuando se crea el reintento,
 *   - las reglas SQL (acción, ventana de mute) coinciden con la política TS,
 *   - el fence real de `markCommandExecutionStarted` (incluido el filtro de
 *     lease) impide que una orden se marque y se reencole a la vez (C4),
 *   - la recuperación de CERBERO 011 neutraliza lo que pudo ejecutarse y deja
 *     fuera de alcance a ZEUS (C5).
 *
 * Requisitos del proyecto desechable: migraciones CERBERO 001→011 (009 y 011 son
 * imprescindibles), la 021 de ZEUS, el marcador, y un grupo fixture con binding
 * habilitado hacia un bot `Cerbero` (tipo `security`, `instance_id` =
 * `zeus-integration-test`) sin el cual todos los reencolados responden
 * `group_not_eligible` y `claim_security_command` no reclama nada.
 */

/** Tabla marcador exigida al proyecto desechable (C7). */
const DISPOSABLE_MARKER_TABLE = "zeus_test_disposable_marker";

/**
 * Inventario local de referencias protegidas (§1).
 *
 * La protección ya no es una lista codificada con un solo elemento: el
 * inventario es un archivo versionado y documentado
 * (`tests/fixtures/protected-project-refs.json`). Si no se puede leer o no es
 * válido, la suite falla cerrado aunque el resto del entorno parezca correcto.
 */
const protectedRefs = loadProtectedRefInventory(PROTECTED_REFS_INVENTORY_PATH);
const staticConfig = evaluateStaticConfig(process.env, protectedRefs);
const url = staticConfig.config.url;
const serviceRoleKey = staticConfig.config.serviceRoleKey;
const groupId = staticConfig.config.groupId;
const operatorId = staticConfig.config.operatorId;

/**
 * La derivación de la referencia de proyecto (URL y clave, incluido el claim
 * `role=service_role` del hallazgo B4) vive en `tests/support/project-refs.ts`,
 * junto con el inventario de referencias protegidas y la evaluación completa de
 * la configuración estática. Aquí sólo se consume el veredicto.
 */

/**
 * Bloqueos ESTÁTICOS (sin red): inventario, URL, clave, referencias protegidas y
 * variables obligatorias. Con cualquier bloqueo no se crea ni un cliente.
 */
const runSkip = staticConfig.blockers.length > 0 ? staticConfig.blockers.join(" | ") : false;

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (!client) {
    if (!url || !serviceRoleKey) {
      throw new Error("Las pruebas de integración no tienen credenciales de prueba.");
    }
    client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

let suiteDbCache: SuiteDb | undefined;

/** Adaptador de infraestructura (preflight, limpieza, bindings, espejo). */
function suite(): SuiteDb {
  if (!suiteDbCache) suiteDbCache = createSupabaseSuiteDb(db());
  return suiteDbCache;
}

/**
 * Fixture de atomicidad (ver `tests/fixtures/security-command-requeue-audit-failure.sql`).
 * La prueba que lo necesita se OMITE si no está armado: nunca se cuenta como
 * aprobada sin haber observado el rollback real.
 */
const AUDIT_FAILURE_REASON = "zeus-it-audit-failure";
/** `instance_id` del bot Cerbero del grupo fixture (lo exige `claim_security_command`). */
const CLAIM_INSTANCE = "zeus-integration-test";
/** Rondas de cada carrera: más oportunidades de solapamiento real de transacciones. */
const CONCURRENCY_ROUNDS = 8;

/**
 * Identificador de ESTA ejecución. Se antepone a cada `operation_key` y se
 * incluye en el motivo auditado, de modo que toda fila que produzca el archivo
 * sea atribuible a esta corrida y la prueba de higiene (bloque E) pueda detectar
 * residuos sin tocar filas ajenas.
 */
const RUN_MARKER = `zeus-it-${randomUUID().slice(0, 8)}`;

// El prefijo es el contrato de atribución con `tests/support/preflight.ts`: si el
// marcador no tiene la forma esperada, la recuperación de residuos dejaría de
// encontrar las filas de esta suite.
if (!RUN_MARKER_PATTERN.test(RUN_MARKER)) {
  throw new Error(`RUN_MARKER inválido: ${RUN_MARKER}`);
}

/** Contrato con `tests/support/preflight.ts`. */
const SUBJECT: SuiteSubject = {
  groupId,
  operatorId,
  runMarker: RUN_MARKER,
  testInstanceId: CLAIM_INSTANCE,
  testBotName: "Cerbero",
  testBotType: "security",
  markerTable: DISPOSABLE_MARKER_TABLE,
  journalPath: fileURLToPath(new URL("./.artifacts/bindings-journal.json", import.meta.url)),
};

/**
 * Problemas de limpieza/restauración detectados durante la corrida (§5).
 *
 * No se lanzan desde `finally` para no ocultar el error original de la prueba:
 * se acumulan aquí y el hook `after` (y la prueba de higiene) fallan al final.
 * Un residuo nunca queda silenciado.
 */
const recordedIssues: string[] = [];

function recordIssues(label: string, items: readonly string[]): void {
  for (const item of items) recordedIssues.push(`${label}: ${item}`);
}

/** Escenario del espejo y su veredicto, decididos una vez al arrancar (§6). */
let mirrorScenario: MirrorScenario = "default";
let mirrorVerdict: MirrorVerdict = {
  blockers: [],
  diagnostics: [],
  runRenameScenario: false,
  skipReason: "no evaluado",
};

/** Bot del entorno de pruebas verificado en el preflight. */
let testBotId: string | null = null;

async function mirrorProbes(): Promise<{ main: MirrorProbe; backup: MirrorProbe }> {
  const main = await suite().select<{ id?: unknown }>(MIRROR_TABLE, {
    columns: "id",
    limit: 1,
  });
  const backup = await suite().select<{ id?: unknown }>(MIRROR_BACKUP_TABLE, {
    columns: "id",
    limit: 1,
  });
  return { main: toMirrorProbe(main), backup: toMirrorProbe(backup) };
}

interface BootstrapResult {
  skip: string | false;
  /** Problemas que exigen intervención manual: fallan, no se omiten. */
  blockers: string[];
  notes: string[];
}

/**
 * Arranque de la suite (§2, §3, §4, §6).
 *
 * Orden estricto:
 *   1. preflight de aislamiento (sólo lecturas);
 *   2. si y sólo si pasó, recuperación de residuos atribuibles;
 *   3. restauración verificada de bindings de una ejecución anterior;
 *   4. segundo preflight, ahora con vaciedad estricta;
 *   5. escenario del espejo.
 *
 * Ninguna escritura ocurre antes de (1). Cualquier comprobación que no se pueda
 * completar detiene la suite: nunca se degrada a "omitir y seguir".
 */
async function bootstrapEnvironment(): Promise<BootstrapResult> {
  const notes: string[] = [];

  const first = decidePreflight(await observePreflight(suite(), SUBJECT), SUBJECT, "initial");
  notes.push(...first.diagnostics);
  if (!first.ok) {
    return { skip: first.blockers.join(" | "), blockers: [], notes };
  }

  if (first.attributableResiduals.length > 0) {
    const recovery = await recoverResiduals(suite(), SUBJECT, first.attributableResiduals);
    notes.push(...recovery.diagnostics);
    if (recovery.blockers.length > 0) {
      return { skip: recovery.blockers.join(" | "), blockers: recovery.blockers, notes };
    }
    notes.push(
      `recuperados ${recovery.deletedCommands} orden(es), ${recovery.deletedEvents} evento(s) ` +
        `y ${recovery.deletedMirrorRows} fila(s) de espejo de ejecuciones anteriores`,
    );
  }

  const restore = await restoreTestBindings(suite(), SUBJECT);
  notes.push(...restore.diagnostics);
  if (restore.blockers.length > 0) {
    return {
      skip: `restauración de bindings pendiente: ${restore.blockers.join(" | ")}`,
      blockers: restore.blockers,
      notes,
    };
  }
  if (restore.restored > 0) {
    notes.push(`restaurados ${restore.restored} binding(s) deshabilitados por una ejecución anterior`);
  }

  const second = decidePreflight(await observePreflight(suite(), SUBJECT), SUBJECT, "post-recovery");
  if (!second.ok) {
    return { skip: second.blockers.join(" | "), blockers: [], notes };
  }
  testBotId = second.testBotId;

  const scenario = parseMirrorScenario(process.env.ZEUS_TEST_SCENARIO);
  if (!scenario.ok) {
    return { skip: scenario.detail, blockers: [], notes };
  }
  mirrorScenario = scenario.scenario;
  const probes = await mirrorProbes();
  mirrorVerdict = evaluateMirrorState({
    scenario: scenario.scenario,
    main: probes.main,
    backup: probes.backup,
  });
  notes.push(...mirrorVerdict.diagnostics);
  if (mirrorVerdict.blockers.length > 0) {
    return { skip: mirrorVerdict.blockers.join(" | "), blockers: mirrorVerdict.blockers, notes };
  }

  return { skip: false, blockers: [], notes };
}

const bootstrap: BootstrapResult = runSkip
  ? { skip: runSkip, blockers: [], notes: [] }
  : await bootstrapEnvironment();

/** Omisión efectiva de TODAS las pruebas de integración. */
const suiteSkip = bootstrap.skip;
/** Bloqueos que deben FALLAR (no omitir) porque dejan el entorno inconsistente. */
const environmentBlockers: readonly string[] = bootstrap.blockers;

for (const note of [...staticConfig.notices, ...bootstrap.notes]) {
  // Diagnóstico visible sin exponer credenciales ni referencias.
  console.error(`[zeus-postgres-suite] ${note}`);
}

/**
 * Primera prueba del archivo: si el entorno quedó inconsistente (espejo
 * renombrado de una ejecución anterior, bindings sin restaurar, residuos que no
 * se pudieron borrar), esto FALLA. No se omite nunca: una inconsistencia que sólo
 * produce omisiones acaba pareciendo una corrida verde.
 */
test("the disposable environment is in a consistent state", () => {
  assert.deepEqual(
    environmentBlockers,
    [],
    `el entorno exige intervención manual antes de ejecutar la suite:\n- ${environmentBlockers.join(
      "\n- ",
    )}`,
  );
});

interface Fixture {
  id: string;
  operationKey: string;
  /** Token del fixture, para emular el fence de `mark_command_execution_started`. */
  token: string;
}

async function insertCommand(overrides: Record<string, unknown>): Promise<Fixture> {
  const operationKey = `${RUN_MARKER}:${
    typeof overrides.operation_key === "string"
      ? overrides.operation_key
      : randomUUID()
  }`;
  const token = randomUUID();
  const { data, error } = await db()
    .from("security_commands")
    .insert({
      group_id: groupId,
      action: "BAN_USER",
      target_user_id: 4242,
      payload: { reason: "integration-test" },
      status: "processing",
      result_state: "processing",
      execution_started_at: null,
      attempts: 1,
      last_error: null,
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      processing_instance_id: CLAIM_INSTANCE,
      processing_token: token,
      processing_at: new Date(Date.now() - 120_000).toISOString(),
      operation_key: operationKey,
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id), operationKey, token };
}

/**
 * Limpieza (C6, §5): sólo las filas de ESTA ejecución, por identificadores
 * exactos, verificando cada borrado (`tests/support/preflight.ts`).
 *
 * Diferencias con la versión anterior:
 *  - las cuatro operaciones se comprueban (antes sólo el espejo lo estaba);
 *  - se distingue "tabla opcional ausente" de "columna ausente" (hallazgo B6),
 *    permisos, conexión y error de borrado;
 *  - el espejo se borra por `command_id âˆˆ {original, reintentos}` **y**
 *    `action='security_command_requeue'` **y** `result` con el `RUN_MARKER`, de
 *    modo que una fila escrita por otro emisor para la misma orden no se toca
 *    (hallazgo B7);
 *  - los problemas no se lanzan aquí (no ocultarían el error original de la
 *    prueba): se acumulan y el hook `after` y la prueba de higiene fallan.
 */
async function cleanup(fixtures: readonly Fixture[]): Promise<void> {
  const report: CleanupReport = await cleanupFixtures(
    suite(),
    SUBJECT,
    fixtures.map((fixture): FixtureRef => ({
      id: fixture.id,
      operationKey: fixture.operationKey,
    })),
  );
  recordIssues("limpieza", report.blockers);
  recordIssues("residuo", report.residue);
  for (const diagnostic of report.diagnostics) {
    console.error(`[zeus-postgres-suite] ${diagnostic}`);
  }
}

function requeueArgs(commandId: string, overrides: Record<string, unknown> = {}) {
  return {
    p_command_id: commandId,
    p_group_id: groupId,
    p_actor_id: operatorId,
    // El motivo viaja a `security_events.details.reason` y al espejo
    // `security_audit_log.result`: incluye RUN_MARKER para poder atribuir
    // cualquier residuo a esta ejecución.
    p_reason: `prueba de integración ${RUN_MARKER}`,
    p_acknowledged: true,
    ...overrides,
  };
}

interface OriginalState {
  status: string | null;
  result_state: string | null;
  processing_instance_id: string | null;
  processing_token: string | null;
  processing_at: string | null;
  lease_expires_at: string | null;
  execution_started_at: string | null;
  executed_at: string | null;
  attempts: number | null;
  last_error: string | null;
}

interface RetryRow {
  id: string;
  status: string | null;
  result_state: string | null;
  operation_key: string | null;
  execution_started_at: string | null;
  attempts: number | null;
}

async function readOriginal(id: string): Promise<OriginalState> {
  const { data, error } = await db()
    .from("security_commands")
    .select(
      "status,result_state,processing_instance_id,processing_token,processing_at,lease_expires_at,execution_started_at,executed_at,attempts,last_error",
    )
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as unknown as OriginalState;
}

async function retryRows(fixture: Fixture): Promise<RetryRow[]> {
  const { data, error } = await db()
    .from("security_commands")
    .select(
      "id,status,result_state,operation_key,execution_started_at,attempts",
    )
    .eq("group_id", groupId)
    .eq("operation_key", `${fixture.operationKey}#retry`);
  if (error) throw error;
  return (data ?? []) as unknown as RetryRow[];
}

async function auditEventsFor(
  fixture: Fixture,
): Promise<Array<{ details: Record<string, unknown> }>> {
  const { data, error } = await db()
    .from("security_events")
    .select("details")
    .eq("group_id", groupId)
    .eq("event_type", "security_command_requeued")
    .filter("details->>originalCommandId", "eq", fixture.id);
  if (error) throw error;
  return (data ?? []) as unknown as Array<{ details: Record<string, unknown> }>;
}

/**
 * Post-condición de un reencolado confirmado: la original queda neutralizada,
 * existe EXACTAMENTE un reintento reclamable y la auditoría obligatoria se
 * escribió una sola vez.
 */
async function assertRequeued(
  fixture: Fixture,
  retryCommandId: unknown,
): Promise<RetryRow> {
  const original = await readOriginal(fixture.id);
  assert.equal(original.result_state, "unknown");
  assert.equal(original.processing_token, null);
  assert.equal(original.processing_at, null);
  assert.equal(original.lease_expires_at, null);

  const retries = await retryRows(fixture);
  assert.equal(retries.length, 1, "exactly one retry must exist");
  assert.equal(retries[0].id, String(retryCommandId));
  assert.equal(retries[0].status, "pending");
  assert.equal(retries[0].result_state, "queued");
  assert.equal(retries[0].execution_started_at, null);

  const events = await auditEventsFor(fixture);
  assert.equal(events.length, 1, "the mandatory audit must be written exactly once");
  return retries[0];
}

/** Post-condición de un rechazo: sin cambios en la original y sin reintento. */
async function assertUntouched(
  fixture: Fixture,
  expected: { status?: string | null; resultState?: string | null } = {},
): Promise<OriginalState> {
  const original = await readOriginal(fixture.id);
  assert.equal(
    original.status,
    expected.status === undefined ? "processing" : expected.status,
  );
  assert.equal(
    original.result_state,
    expected.resultState === undefined ? "processing" : expected.resultState,
  );
  assert.notEqual(original.processing_token, null);
  assert.equal((await retryRows(fixture)).length, 0);
  assert.equal((await auditEventsFor(fixture)).length, 0);
  return original;
}

async function auditFailureFixture(): Promise<{ armed: boolean; detail: string }> {
  const { error } = await db()
    .from("zeus_test_audit_failure")
    .select("reason")
    .limit(1);
  if (error) {
    return {
      armed: false,
      detail:
        "fixture de atomicidad no instalado (" +
        `${error.code ?? error.message}); ver tests/fixtures/security-command-requeue-audit-failure.sql`,
    };
  }
  const { data, error: armError } = await db()
    .from("zeus_test_audit_failure")
    .select("reason")
    .eq("reason", AUDIT_FAILURE_REASON)
    .maybeSingle();
  if (armError) {
    return { armed: false, detail: `fixture no comprobable: ${armError.message}` };
  }
  if (!data) {
    return {
      armed: false,
      detail: `el fixture existe pero falta la fila reason='${AUDIT_FAILURE_REASON}'`,
    };
  }
  return { armed: true, detail: "" };
}

async function securityAuditLogPresent(): Promise<boolean> {
  const probe = (await mirrorProbes()).main;
  if (probe.error) {
    throw new Error(`no se puede comprobar ${MIRROR_TABLE}: ${probe.error}`);
  }
  return probe.present;
}

/**
 * Comprueba que `claim_security_command` (CERBERO 011) puede reclamar en el
 * proyecto de pruebas: grupo activo, binding habilitado y un bot `Cerbero`
 * (`type='security'`) con `instance_id = CLAIM_INSTANCE`.
 *
 * Si no reclama, las pruebas que dependen de CERBERO se OMITEN con el motivo:
 * nunca se cuentan como aprobadas. Usa una orden `pending` propia y la borra
 * siempre. `claim` toma la orden `pending` más antigua del proyecto, así que un
 * residuo ajeno produce una omisión (no un falso positivo).
 */
async function claimEligibility(): Promise<{ ready: boolean; detail: string }> {
  const probe = await insertCommand({
    status: "pending",
    result_state: "queued",
    attempts: 0,
  });
  try {
    const { data, error } = await db().rpc("claim_security_command", {
      p_instance_id: CLAIM_INSTANCE,
    });
    if (error) {
      return {
        ready: false,
        detail: `claim_security_command no disponible: ${error.code ?? error.message}`,
      };
    }
    const claimed = ((data ?? []) as Array<Record<string, unknown>>).some(
      (row) => String(row?.id ?? "") === probe.id,
    );
    return claimed
      ? { ready: true, detail: "" }
      : {
          ready: false,
          detail:
            `claim_security_command no reclama con p_instance_id=${CLAIM_INSTANCE}: ` +
            "falta un binding habilitado con un bot Cerbero (type=security) en el grupo " +
            "fixture, o hay órdenes pendientes ajenas más antiguas",
        };
  } finally {
    await db().from("security_commands").delete().eq("id", probe.id);
  }
}

/**
 * Bindings del grupo fixture: se deshabilitan con diario persistente y se
 * restauran de forma verificable (`tests/support/preflight.ts`, §4).
 *
 * El diario (`tests/.artifacts/bindings-journal.json`) sobrevive a `kill -9`, de
 * modo que la siguiente ejecución restaura el estado original antes de empezar,
 * aunque este proceso no llegue a ejecutar ningún `finally`.
 */
async function disarmBindings(): Promise<void> {
  if (!testBotId) {
    throw new Error(
      "no se conoce el bot del entorno de pruebas: el preflight no lo verificó",
    );
  }
  const disarm = await disarmTestBindings(suite(), SUBJECT, [testBotId]);
  if (disarm.blockers.length > 0) {
    throw new Error(`no se pudieron deshabilitar los bindings: ${disarm.blockers.join(" | ")}`);
  }
}

after(async () => {
  if (suiteSkip) return;

  const problems: string[] = [...recordedIssues];
  const restore = await restoreTestBindings(suite(), SUBJECT);
  if (restore.blockers.length > 0) problems.push(...restore.blockers);

  if (problems.length > 0) {
    // Falla el archivo: un entorno inconsistente no se puede omitir en silencio.
    throw new Error(
      `la suite dejó el entorno inconsistente y requiere intervención manual:\n- ${problems.join(
        "\n- ",
      )}`,
    );
  }
});

test(
  "two concurrent requeues of the same stale order produce exactly one retry",
  { skip: suiteSkip },
  async () => {
    const fixtures: Fixture[] = [];
    const fixture = await insertCommand({});
    fixtures.push(fixture);

    try {
      const [first, second] = await Promise.all([
        db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
        db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
      ]);
      assert.equal(first.error, null);
      assert.equal(second.error, null);

      const outcomes = [first.data?.[0], second.data?.[0]]
        .map((row) => String(row?.outcome ?? ""))
        .sort();
      assert.deepEqual(outcomes, ["already_retried", "requeued"]);

      const winner = [first.data?.[0], second.data?.[0]].find(
        (row) => row?.outcome === "requeued",
      );
      assert.ok(winner?.retry_command_id);

      const { data: original } = await db()
        .from("security_commands")
        .select(
          "status,result_state,processing_instance_id,processing_token,lease_expires_at,processing_at,execution_started_at",
        )
        .eq("id", fixture.id)
        .single();
      assert.equal(original?.result_state, "unknown");
      assert.equal(original?.processing_token, null);
      assert.equal(original?.lease_expires_at, null);
      assert.equal(original?.processing_at, null);

      const { data: retry } = await db()
        .from("security_commands")
        .select("status,result_state,operation_key,execution_started_at,attempts")
        .eq("id", winner?.retry_command_id as string)
        .single();
      assert.equal(retry?.status, "pending");
      assert.equal(retry?.result_state, "queued");
      assert.equal(retry?.operation_key, `${fixture.operationKey}#retry`);
      assert.equal(retry?.execution_started_at, null);
      assert.equal(retry?.attempts, 0);

      const { data: events } = await db()
        .from("security_events")
        .select("details")
        .eq("group_id", groupId)
        .eq("event_type", "security_command_requeued")
        .filter("details->>originalCommandId", "eq", fixture.id);
      assert.equal(events?.length, 1, "audit must be written exactly once");
      assert.equal(
        Number((events?.[0]?.details as Record<string, unknown>).actorId),
        operatorId,
      );
    } finally {
      await cleanup(fixtures);
    }
  },
);

test(
  "an order whose execution may have started is never requeued",
  { skip: suiteSkip },
  async () => {
    const fixture = await insertCommand({
      execution_started_at: new Date().toISOString(),
    });
    try {
      const { data, error } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id),
      );
      assert.equal(error, null);
      assert.equal(data?.[0]?.outcome, "execution_may_have_started");

      const { data: original } = await db()
        .from("security_commands")
        .select("result_state,processing_token")
        .eq("id", fixture.id)
        .single();
      assert.equal(original?.result_state, "processing");
      assert.notEqual(original?.processing_token, null);
    } finally {
      await cleanup([fixture]);
    }
  },
);

test(
  "the SQL rules match the TypeScript policy for rejected actions and expired mutes",
  { skip: suiteSkip },
  async () => {
    // B5: los fixtures se insertan DENTRO del `try`. Si la segunda inserción
    // falla, la primera quedaría huérfana para siempre (la limpieza vive en el
    // `finally`).
    const fixtures: Fixture[] = [];
    try {
      const expiredMute = await insertCommand({
        action: "MUTE_USER",
        payload: { until_date: Math.floor(Date.now() / 1000) - 60 },
      });
      fixtures.push(expiredMute);
      const kick = await insertCommand({ action: "KICK_USER" });
      fixtures.push(kick);
      const warn = await insertCommand({ action: "WARN_USER" });
      fixtures.push(warn);

      const cases: Array<[Fixture, string]> = [
        [expiredMute, "temporal_window_expired"],
        [kick, "not_retryable"],
        [warn, "not_retryable"],
      ];
      for (const [fixture, expected] of cases) {
        const { data, error } = await db().rpc(
          "zeus_requeue_security_command",
          requeueArgs(fixture.id),
        );
        assert.equal(error, null);
        assert.equal(data?.[0]?.outcome, expected, fixture.operationKey);
      }
    } finally {
      await cleanup(fixtures);
    }
  },
);

test(
  "the unique index rejects a duplicated operation key",
  { skip: suiteSkip },
  async () => {
    const fixture = await insertCommand({ status: "pending", result_state: "queued" });
    try {
      const { error } = await db().from("security_commands").insert({
        group_id: groupId,
        action: "BAN_USER",
        target_user_id: 4242,
        payload: { reason: "duplicate" },
        status: "pending",
        result_state: "queued",
        operation_key: fixture.operationKey,
      });
      assert.equal(error?.code, "23505");
    } finally {
      await cleanup([fixture]);
    }
  },
);

test(
  "an order from another group is never touched by the requeue",
  { skip: suiteSkip },
  async () => {
    const fixture = await insertCommand({});
    try {
      const { data, error } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id, { p_group_id: groupId + 1 }),
      );
      assert.equal(error, null);
      assert.equal(data?.[0]?.outcome, "not_found");

      const { data: original } = await db()
        .from("security_commands")
        .select("status,result_state,processing_token,lease_expires_at")
        .eq("id", fixture.id)
        .single();
      assert.equal(original?.status, "processing");
      assert.equal(original?.result_state, "processing");
      assert.notEqual(original?.processing_token, null);
      assert.notEqual(original?.lease_expires_at, null);
    } finally {
      await cleanup([fixture]);
    }
  },
);

// ---------------------------------------------------------------------------
// A. Atomicidad y rollback
// ---------------------------------------------------------------------------

test(
  "if the mandatory audit insert fails, the whole requeue is rolled back",
  { skip: suiteSkip },
  async (t) => {
    const fixtureState = await auditFailureFixture();
    if (!fixtureState.armed) {
      t.skip(fixtureState.detail);
      return;
    }

    const fixture = await insertCommand({});
    try {
      const { data, error } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id, { p_reason: AUDIT_FAILURE_REASON }),
      );

      assert.notEqual(
        error,
        null,
        "the RPC must fail when the mandatory audit cannot be written",
      );
      assert.equal(data, null);

      // Ni neutralización, ni reintento, ni auditoría parcial.
      const original = await assertUntouched(fixture);
      assert.equal(original.last_error, null);
      assert.equal(original.execution_started_at, null);
    } finally {
      await cleanup([fixture]);
    }
  },
);

test(
  "the optional security_audit_log mirror may fail without invalidating the mandatory audit",
  { skip: suiteSkip || mirrorVerdict.skipReason || false },
  async () => {
    // Escenario `audit-log-rename` (§6): el operador renombro la tabla ANTES de
    // ejecutar y la restaura DESPUES; PostgREST no ejecuta DDL, asi que la suite
    // solo verifica el estado esperado (ya validado en el arranque) y nunca
    // renombra ni "restaura" a medias.
    assert.equal(mirrorScenario, "audit-log-rename");
    assert.equal(
      await securityAuditLogPresent(),
      false,
      `${MIRROR_TABLE} debe seguir ausente durante este escenario`,
    );
    assert.equal(
      (await mirrorProbes()).backup.present,
      true,
      `${MIRROR_BACKUP_TABLE} debe existir durante este escenario (tabla renombrada)`,
    );

    const fixture = await insertCommand({});
    try {
      const { data, error } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id),
      );
      assert.equal(error, null);
      assert.equal(data?.[0]?.outcome, "requeued");
      // El reintento y la auditoria obligatoria sobreviven sin el espejo.
      await assertRequeued(fixture, data?.[0]?.retry_command_id);
    } finally {
      await cleanup([fixture]);
    }
  },
);

test(
  "an order without explicit acknowledgement is never requeued, even with service_role",
  { skip: suiteSkip },
  async () => {
    const fixture = await insertCommand({});
    try {
      const { data, error } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id, { p_acknowledged: false }),
      );
      assert.equal(error, null);
      assert.equal(data?.[0]?.outcome, "confirmation_required");
      await assertUntouched(fixture);
    } finally {
      await cleanup([fixture]);
    }
  },
);



// ---------------------------------------------------------------------------
// B. Concurrencia con transacciones independientes
// ---------------------------------------------------------------------------

test(
  "the exact CERBERO start fence never coexists with a requeue",
  { skip: suiteSkip },
  async () => {
    /**
     * Réplica EXACTA de `markCommandExecutionStarted` (CERBERO
     * `src/database/repositories/commands-repository.ts`), con sus filtros
     * completos: status, result_state, processing_instance_id, processing_token,
     * `execution_started_at is null` y `lease_expires_at > now` (C4). Antes
     * faltaba el filtro de lease, así que el fence simulado era más permisivo
     * que el real.
     */
    const markStarted = (fixture: Fixture) => {
      const now = new Date();
      return db()
        .from("security_commands")
        .update({ execution_started_at: now.toISOString() })
        .eq("id", fixture.id)
        .eq("status", "processing")
        .eq("result_state", "processing")
        .eq("processing_instance_id", CLAIM_INSTANCE)
        .eq("processing_token", fixture.token)
        .is("execution_started_at", null)
        .gt("lease_expires_at", now.toISOString())
        .select("id");
    };

    // 1) Lease vencido â€” el Ãºnico caso que ZEUS puede reencolar: el fence NO
    //    puede marcar el inicio, así que una orden stale nunca queda a la vez
    //    ejecutada y reencolada.
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const fixture = await insertCommand({});
      try {
        const [mark, requeue] = await Promise.all([
          markStarted(fixture),
          db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
        ]);

        assert.equal(mark.error, null);
        assert.equal(requeue.error, null);
        const marked = mark.data?.length ?? 0;
        const outcome = String(requeue.data?.[0]?.outcome ?? "");

        assert.ok(
          !(marked === 1 && outcome === "requeued"),
          `round ${round}: the same order was both started and requeued`,
        );
        assert.equal(
          marked,
          0,
          `round ${round}: el fence no debe marcar un inicio con lease vencido`,
        );
        assert.equal(outcome, "requeued", `round ${round}`);
        await assertRequeued(fixture, requeue.data?.[0]?.retry_command_id);
        const original = await readOriginal(fixture.id);
        assert.equal(
          original.execution_started_at,
          null,
          "a requeued order must never carry a start mark",
        );
      } finally {
        await cleanup([fixture]);
      }
    }

    // 2) Lease vigente: el fence sí marca y ZEUS se niega a reencolar
    //    (`not_stale`). Sin este bloque el filtro de lease del fence podría ser
    //    código muerto y nadie lo notaría.
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const fixture = await insertCommand({
        lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      try {
        const [mark, requeue] = await Promise.all([
          markStarted(fixture),
          db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
        ]);

        assert.equal(mark.error, null);
        assert.equal(requeue.error, null);
        assert.equal(
          mark.data?.length ?? 0,
          1,
          `round ${round}: el fence debe marcar el inicio con lease vigente`,
        );
        assert.equal(
          String(requeue.data?.[0]?.outcome ?? ""),
          "not_stale",
          `round ${round}`,
        );

        const original = await readOriginal(fixture.id);
        assert.equal(original.result_state, "processing");
        assert.notEqual(original.processing_token, null);
        assert.notEqual(original.execution_started_at, null);
        assert.equal((await retryRows(fixture)).length, 0);
        assert.equal((await auditEventsFor(fixture)).length, 0);
      } finally {
        await cleanup([fixture]);
      }
    }
  },
);

test(
  "a concurrent lease claim never produces a neutralized order without a retry",
  { skip: suiteSkip },
  async () => {
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const fixture = await insertCommand({});
      try {
        const claim = db()
          .from("security_commands")
          .update({
            processing_instance_id: CLAIM_INSTANCE,
            processing_at: new Date().toISOString(),
            lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
            processing_token: randomUUID(),
          })
          .eq("id", fixture.id)
          .eq("status", "processing")
          .eq("result_state", "processing")
          .is("execution_started_at", null)
          .select("id");

        const [claimResult, requeue] = await Promise.all([
          claim,
          db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
        ]);

        assert.equal(claimResult.error, null);
        assert.equal(requeue.error, null);
        const claimed = claimResult.data?.length ?? 0;
        const outcome = String(requeue.data?.[0]?.outcome ?? "");

        assert.ok(
          !(claimed === 1 && outcome === "requeued"),
          `round ${round}: the order was claimed and requeued at the same time`,
        );

        if (outcome === "requeued") {
          await assertRequeued(fixture, requeue.data?.[0]?.retry_command_id);
        } else {
          assert.ok(
            outcome === "not_stale" || outcome === "concurrent_change",
            `round ${round}: unexpected outcome ${outcome}`,
          );
          const original = await readOriginal(fixture.id);
          assert.equal(original.result_state, "processing");
          assert.equal((await retryRows(fixture)).length, 0);
        }
      } finally {
        await cleanup([fixture]);
      }
    }
  },
);

test(
  "claim_security_command and the requeue never take the same order",
  { skip: suiteSkip },
  async (t) => {
    const eligibility = await claimEligibility();
    if (!eligibility.ready) {
      t.skip(eligibility.detail);
      return;
    }

    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const fixture = await insertCommand({});
      try {
        const [claim, requeue] = await Promise.all([
          db().rpc("claim_security_command", { p_instance_id: CLAIM_INSTANCE }),
          db().rpc("zeus_requeue_security_command", requeueArgs(fixture.id)),
        ]);
        assert.equal(claim.error, null);
        assert.equal(requeue.error, null);

        const claimedOurs = ((claim.data ?? []) as Array<Record<string, unknown>>).some(
          (row) => String(row?.id ?? "") === fixture.id,
        );
        const outcome = String(requeue.data?.[0]?.outcome ?? "");

        assert.ok(
          !(claimedOurs && outcome === "requeued"),
          `round ${round}: CERBERO claimed the order that ZEUS requeued`,
        );
        if (outcome === "requeued") {
          await assertRequeued(fixture, requeue.data?.[0]?.retry_command_id);
        } else {
          assert.equal((await retryRows(fixture)).length, 0);
        }
      } finally {
        await cleanup([fixture]);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// C. Estados y límites
// ---------------------------------------------------------------------------

test(
  "the attempt limit and the retry depth are enforced by SQL",
  { skip: suiteSkip },
  async () => {
    // B5: inserciones dentro del `try` para que un fallo parcial no filtre filas.
    const fixtures: Fixture[] = [];
    try {
      const exhausted = await insertCommand({ attempts: 5 });
      fixtures.push(exhausted);
      const deep = await insertCommand({
        operation_key: `${randomUUID()}#retry#retry#retry`,
      });
      fixtures.push(deep);
      const shallow = await insertCommand({ operation_key: `${randomUUID()}#retry#retry` });
      fixtures.push(shallow);

      const refused: Array<[Fixture, string]> = [
        [exhausted, "attempts_exhausted"],
        [deep, "retry_limit_reached"],
      ];
      for (const [fixture, expected] of refused) {
        const { data, error } = await db().rpc(
          "zeus_requeue_security_command",
          requeueArgs(fixture.id),
        );
        assert.equal(error, null);
        assert.equal(data?.[0]?.outcome, expected, fixture.operationKey);
        assert.equal((await retryRows(fixture)).length, 0);
      }

      // Profundidad 2 todavía se permite: el límite es >= 3.
      const allowed = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(shallow.id),
      );
      assert.equal(allowed.error, null);
      assert.equal(allowed.data?.[0]?.outcome, "requeued");
      assert.equal(
        allowed.data?.[0]?.retry_operation_key,
        `${shallow.operationKey}#retry`,
      );
      await assertRequeued(shallow, allowed.data?.[0]?.retry_command_id);
    } finally {
      await cleanup(fixtures);
    }
  },
);

test(
  "result_state NULL is impossible under migration 009 and queued is refused by SQL",
  { skip: suiteSkip },
  async () => {
    // C1: la migración 009 (`alter column result_state set not null`) hace que la
    // fila no exista: PostgREST devuelve 23502 al insertar. La rama
    // `result_state is null -> unsupported_result_state` de la 021 es defensiva
    // para bases sin 009 y NO es representable en un esquema correcto, así que la
    // prueba verifica el rechazo real y que no queda ninguna fila escrita.
    const rejectedKey = "null-state";
    let insertError: { code?: string; message?: string } | null = null;
    try {
      await insertCommand({ result_state: null, operation_key: rejectedKey });
    } catch (error) {
      insertError = error as { code?: string; message?: string };
    }
    assert.ok(
      insertError,
      "insertar result_state=NULL debe fallar: la columna es NOT NULL desde 009",
    );
    assert.equal(
      insertError.code,
      "23502",
      `se esperaba una violación NOT NULL (23502); recibido ${insertError.code ?? insertError.message}`,
    );

    const { data: leftovers, error: leftoverError } = await db()
      .from("security_commands")
      .select("id")
      .eq("group_id", groupId)
      .eq("operation_key", `${RUN_MARKER}:${rejectedKey}`);
    assert.equal(leftoverError, null);
    assert.equal((leftovers ?? []).length, 0, "la inserción rechazada no debe dejar filas");

    // `queued` sí es representable (dentro del CHECK de 009) y la RPC lo rechaza
    // sin tocar la orden.
    const queuedState = await insertCommand({
      status: "processing",
      result_state: "queued",
    });
    try {
      const queued = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(queuedState.id),
      );
      assert.equal(queued.error, null);
      assert.equal(queued.data?.[0]?.outcome, "unsupported_result_state");
      assert.equal(queued.data?.[0]?.original_result_state, "queued");
      await assertUntouched(queuedState, { resultState: "queued" });
    } finally {
      await cleanup([queuedState]);
    }
  },
);


test(
  "a group without an enabled Cerbero binding is never requeued",
  { skip: suiteSkip },
  async () => {
    // El preflight ya verifico que TODOS los bindings del grupo pertenecen al bot
    // del entorno de pruebas (tests/support/preflight.ts), asi que aqui no se
    // deshabilita nada ajeno.
    assert.ok(testBotId, "el preflight debe haber verificado el bot de pruebas");

    const fixture = await insertCommand({});
    try {
      // El diario persistente registra el estado original ANTES de deshabilitar.
      await disarmBindings();
      const disabled = await db()
        .from("group_bot_bindings")
        .select("bot_id,enabled")
        .eq("group_id", groupId)
        .eq("bot_id", testBotId)
        .eq("enabled", false);
      assert.equal(disabled.error, null);
      assert.equal(
        (disabled.data ?? []).length,
        1,
        "el unico binding del bot de pruebas debe quedar deshabilitado y verificado",
      );

      const { data, error: rpcError } = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(fixture.id),
      );
      assert.equal(rpcError, null);
      assert.equal(data?.[0]?.outcome, "group_not_eligible");
      await assertUntouched(fixture);
    } finally {
      // Restauracion verificada (no "enabled=true" a ciegas): relee y compara con
      // el estado original guardado en el diario, y falla si no coincide.
      const restore = await restoreTestBindings(suite(), SUBJECT);
      assert.deepEqual(restore.blockers, []);
      assert.equal(restore.pending, 0, "no debe quedar ningun binding sin restaurar");
      await cleanup([fixture]);
    }
  },
);

test(
  "the mute window is enforced identically by TS and SQL without racing the clock",
  { skip: suiteSkip },
  async () => {
    // C3: `until_date` es un instante ABSOLUTO y el SQL lo compara con `now()`
    // del SERVIDOR. Con +31 s cualquier latencia (o un desfase de reloj entre el
    // cliente y la base) convierte el caso "permitido" en un falso rojo, así que
    // el lado SQL usa márgenes amplios: 1 h vencido y 10x el mínimo restante.
    // La frontera exacta se verifica en la política TS con un reloj fijo.
    const SAFE_MARGIN_SECONDS = (MUTE_MIN_REMAINING_MS / 1000) * 10;
    const nowSec = Math.floor(Date.now() / 1000);

    // B5: inserciones dentro del `try`.
    const fixtures: Fixture[] = [];
    try {
      const expired = await insertCommand({
        action: "MUTE_USER",
        payload: { until_date: nowSec - 3600 },
      });
      fixtures.push(expired);
      const valid = await insertCommand({
        action: "MUTE_USER",
        payload: { until_date: nowSec + SAFE_MARGIN_SECONDS },
      });
      fixtures.push(valid);

      const refused = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(expired.id),
      );
      assert.equal(refused.error, null);
      assert.equal(refused.data?.[0]?.outcome, "temporal_window_expired");
      assert.equal((await retryRows(expired)).length, 0);

      const allowed = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(valid.id),
      );
      assert.equal(allowed.error, null);
      assert.equal(allowed.data?.[0]?.outcome, "requeued");
      await assertRequeued(valid, allowed.data?.[0]?.retry_command_id);

      // Mismo `now` en las tres evaluaciones: sin deriva de reloj.
      const now = Date.now();
      const base = {
        action: "MUTE_USER" as const,
        status: "processing" as const,
        resultState: "processing" as const,
        executionStartedAt: null,
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
        processingAt: new Date(now - 120_000).toISOString(),
        attempts: 1,
        operationKey: "mute-boundary-key",
        acknowledged: true,
        now,
      };
      const tsBoundary = evaluateSecurityCommandReplayPolicy({
        ...base,
        payload: { until_date: Math.floor(now / 1000) + MUTE_MIN_REMAINING_MS / 1000 },
      });
      assert.equal(tsBoundary.allowed, false);
      assert.equal(tsBoundary.reason, "temporal_window_expired");

      const tsAbove = evaluateSecurityCommandReplayPolicy({
        ...base,
        payload: {
          until_date: Math.floor(now / 1000) + MUTE_MIN_REMAINING_MS / 1000 + 1,
        },
      });
      assert.equal(tsAbove.allowed, true);
    } finally {
      await cleanup(fixtures);
    }
  },
);


// ---------------------------------------------------------------------------
// D. Compatibilidad TS / SQL
// ---------------------------------------------------------------------------

test(
  "TypeScript and SQL classify every shared case the same way",
  { skip: suiteSkip },
  async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cases: Array<{
      name: string;
      overrides: Record<string, unknown>;
      acknowledged?: boolean;
      expect: string;
    }> = [
      { name: "stale processing", overrides: {}, expect: "requeued" },
      {
        name: "start mark",
        overrides: { execution_started_at: new Date().toISOString() },
        expect: "execution_may_have_started",
      },
      {
        name: "live lease",
        overrides: { lease_expires_at: new Date(Date.now() + 600_000).toISOString() },
        expect: "not_stale",
      },
      { name: "attempts exhausted", overrides: { attempts: 5 }, expect: "attempts_exhausted" },
      { name: "not retryable", overrides: { action: "KICK_USER" }, expect: "not_retryable" },
      {
        name: "expired mute",
        overrides: { action: "MUTE_USER", payload: { until_date: nowSec - 60 } },
        expect: "temporal_window_expired",
      },
      // B1: `payload ? 'until_date'` en 021. Una clave PRESENTE con valor `null`
      // se rechaza (jsonb_typeof <> 'number'); sin la clave se permite. Ambos
      // lados deben coincidir, y antes no coincidían.
      {
        name: "null until_date",
        overrides: { action: "MUTE_USER", payload: { until_date: null } },
        expect: "temporal_window_expired",
      },
      {
        name: "absent until_date",
        overrides: { action: "MUTE_USER", payload: { reason: "sin ventana" } },
        expect: "requeued",
      },
      { name: "queued", overrides: { result_state: "queued" }, expect: "unsupported_result_state" },
      // C2: `result_state = null` NO pertenece a esta matriz. La migración 009 lo
      // hace imposible (`set not null`), así que el caso se verifica en su propia
      // prueba como violación 23502. Incluirlo aquí sólo producía un error de
      // inserción que la matriz toleraba.
      {
        name: "retry depth",
        overrides: { operation_key: `${randomUUID()}#retry#retry#retry` },
        expect: "retry_limit_reached",
      },
      {
        name: "no acknowledgement",
        overrides: {},
        acknowledged: false,
        expect: "confirmation_required",
      },
      // C8: `unknown` sin confirmación y con confirmación. Antes de C9 la política
      // TS devolvía `execution_outcome_unknown` para el primero y la RPC
      // `confirmation_required`: una divergencia real que esta matriz ahora
      // detecta (y que la corrección eliminó).
      {
        name: "unknown without acknowledgement",
        overrides: { result_state: "unknown", lease_expires_at: null, processing_at: null },
        acknowledged: false,
        expect: "confirmation_required",
      },
      {
        name: "unknown with acknowledgement",
        overrides: { result_state: "unknown", lease_expires_at: null, processing_at: null },
        expect: "requeued",
      },
    ];

    for (const item of cases) {
      // C2: cualquier error de inserción falla la prueba. Aceptar códigos
      // distintos del esperado (o saltar el caso) convertía la matriz en una
      // cobertura aparente: aquí todos los casos son representables con
      // CERBERO 001â†’011 + ZEUS 021.
      const fixture = await insertCommand(item.overrides);

      try {
        const { data, error } = await db().rpc(
          "zeus_requeue_security_command",
          requeueArgs(
            fixture.id,
            item.acknowledged === false ? { p_acknowledged: false } : {},
          ),
        );
        assert.equal(error, null, item.name);
        const sqlOutcome = String(data?.[0]?.outcome ?? "");

        const policy = evaluateSecurityCommandReplayPolicy({
          action: (item.overrides.action ?? "BAN_USER") as SecurityAction,
          payload: (item.overrides.payload ?? { reason: "integration-test" }) as
            SecurityCommandPayload,
          status: String(item.overrides.status ?? "processing"),
          resultState: (item.overrides.result_state === undefined
            ? "processing"
            : item.overrides.result_state) as SecurityCommandResultState | null,
          executionStartedAt:
            (item.overrides.execution_started_at as string | undefined) ?? null,
          // `undefined` = valor por defecto del fixture; `null` explícito se
          // respeta (los casos `unknown` no tienen lease ni `processing_at`).
          leaseExpiresAt:
            item.overrides.lease_expires_at === undefined
              ? new Date(Date.now() - 60_000).toISOString()
              : (item.overrides.lease_expires_at as string | null),
          processingAt:
            item.overrides.processing_at === undefined
              ? new Date(Date.now() - 120_000).toISOString()
              : (item.overrides.processing_at as string | null),
          attempts: Number(item.overrides.attempts ?? 1),
          operationKey: fixture.operationKey,
          acknowledged: item.acknowledged !== false,
          now: Date.now(),
        });
        const tsOutcome = policy.allowed ? "requeued" : String(policy.reason ?? "");

        assert.equal(sqlOutcome, item.expect, `${item.name}: SQL outcome`);
        assert.equal(tsOutcome, sqlOutcome, `${item.name}: TS/SQL parity`);
      } finally {
        await cleanup([fixture]);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// E. Neutralización de CERBERO 011 (C5)
// ---------------------------------------------------------------------------

test(
  "migration 011 neutralization leaves the order out of reach of claim and requeue",
  { skip: suiteSkip },
  async (t) => {
    const eligibility = await claimEligibility();
    if (!eligibility.ready) {
      t.skip(eligibility.detail);
      return;
    }

    // C5: fixture REALMENTE elegible para la recuperación de la migración 011.
    // El `claim` neutraliza dos clases de orden abandonada:
    //   (a) lease vencido y `execution_started_at` no nulo -> result_state
    //       'unknown', sin token ni lease, conservando la marca de inicio;
    //   (b) attempts >= 5 sin marca de inicio -> status/result_state 'failed'.
    // B5: inserciones dentro del `try`.
    const fixtures: Fixture[] = [];
    try {
      const maybeExecuted = await insertCommand({
        execution_started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        lease_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        attempts: 1,
      });
      fixtures.push(maybeExecuted);
      const exhausted = await insertCommand({
        execution_started_at: null,
        lease_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        attempts: 5,
      });
      fixtures.push(exhausted);

      const { data, error } = await db().rpc("claim_security_command", {
        p_instance_id: CLAIM_INSTANCE,
      });
      assert.equal(error, null);
      const claimed = ((data ?? []) as Array<Record<string, unknown>>).map((row) =>
        String(row?.id ?? ""),
      );
      assert.ok(
        !claimed.includes(maybeExecuted.id),
        "011 no debe reclamar una orden que pudo ejecutarse",
      );
      assert.ok(
        !claimed.includes(exhausted.id),
        "011 no debe reclamar una orden sin intentos disponibles",
      );

      // (a) Invariantes de la neutralización.
      const neutralized = await readOriginal(maybeExecuted.id);
      assert.equal(neutralized.status, "processing");
      assert.equal(neutralized.result_state, "unknown");
      assert.equal(neutralized.processing_instance_id, null);
      assert.equal(neutralized.processing_token, null);
      assert.equal(neutralized.processing_at, null);
      assert.equal(neutralized.lease_expires_at, null);
      // La marca de inicio se conserva: es la prueba de que pudo ejecutarse.
      assert.notEqual(neutralized.execution_started_at, null);
      assert.match(String(neutralized.last_error), /reconcile manually/);

      // (b) Invariantes del agotamiento de intentos.
      const failed = await readOriginal(exhausted.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.result_state, "failed");
      assert.notEqual(failed.executed_at, null);
      assert.equal(failed.processing_instance_id, null);
      assert.equal(failed.processing_token, null);
      assert.equal(failed.lease_expires_at, null);
      assert.match(String(failed.last_error), /attempt limit exceeded/);

      // ZEUS tampoco puede reencolar la orden neutralizada: la marca de inicio
      // gana siempre sobre el reencolado.
      const requeue = await db().rpc(
        "zeus_requeue_security_command",
        requeueArgs(maybeExecuted.id),
      );
      assert.equal(requeue.error, null);
      assert.equal(requeue.data?.[0]?.outcome, "execution_may_have_started");
      assert.equal((await retryRows(maybeExecuted)).length, 0);
      assert.equal((await auditEventsFor(maybeExecuted)).length, 0);
    } finally {
      await cleanup(fixtures);
    }
  },
);

// ---------------------------------------------------------------------------
// F. Higiene: sin residuos propios ni espejo renombrado (C6)
// ---------------------------------------------------------------------------

test("the run leaves no rows of its own behind", { skip: suiteSkip }, async () => {
  // Problemas detectados por la limpieza y la restauracion verificadas (§4, §5):
  // se acumulan para no ocultar el error original y fallan aqui.
  assert.deepEqual(
    recordedIssues,
    [],
    `la suite dejo problemas sin resolver:\n- ${recordedIssues.join("\n- ")}`,
  );

  const { data: commands, error: commandError } = await db()
    .from("security_commands")
    .select("id")
    .eq("group_id", groupId)
    .like("operation_key", `${RUN_MARKER}:%`);
  assert.equal(commandError, null);
  assert.deepEqual(commands ?? [], [], "quedaron ordenes de esta ejecucion sin borrar");

  const { data: events, error: eventError } = await db()
    .from("security_events")
    .select("details")
    .eq("group_id", groupId)
    .filter("details->>reason", "like", `%${RUN_MARKER}%`);
  assert.equal(eventError, null);
  assert.deepEqual(events ?? [], [], "quedaron eventos de auditoria de esta ejecucion");

  // Espejo: la RPC lo escribe con el motivo en `result`, asi que RUN_MARKER
  // permite detectar filas propias sin borrar ni contar las ajenas.
  const mirror = await mirrorProbes();
  if (!mirror.main.present) {
    assert.equal(
      mirror.main.error,
      null,
      `${MIRROR_TABLE} no consultable: ${mirror.main.error}`,
    );
    // Escenario `audit-log-rename` o proyecto sin espejo: no hay nada que revisar.
    assert.ok(
      mirrorScenario === "audit-log-rename" || !mirror.backup.present,
      "si el espejo no existe, no puede existir un backup inesperado",
    );
    return;
  }
  const { data: mirrorRows, error: mirrorError } = await db()
    .from(MIRROR_TABLE)
    .select("result")
    .filter("result", "like", `%${RUN_MARKER}%`);
  assert.equal(mirrorError, null, `espejo no consultable: ${mirrorError?.message ?? ""}`);
  assert.deepEqual(
    mirrorRows ?? [],
    [],
    `el espejo ${MIRROR_TABLE} conserva filas de esta ejecucion (C6)`,
  );
});

test(
  "the mirror table state matches the selected scenario",
  { skip: suiteSkip },
  async () => {
    const probes = await mirrorProbes();

    if (mirrorScenario === "audit-log-rename") {
      // Estado preparado por el operador: la suite no puede renombrar (no hay DDL)
      // y tampoco lo deshace. Se verifica que no se haya movido nada mas.
      assert.equal(probes.main.present, false, `${MIRROR_TABLE} debe seguir renombrada`);
      assert.equal(probes.backup.present, true, `${MIRROR_BACKUP_TABLE} debe seguir existiendo`);
      console.error(
        `[zeus-postgres-suite] el escenario 'audit-log-rename' termino: restaurar la tabla con \`${MIRROR_RESTORE_STATEMENT}\``,
      );
      return;
    }

    // Escenario por defecto: ningun renombrado pendiente.
    assert.equal(
      probes.backup.present,
      false,
      `la tabla espejo quedo renombrada: restaurar con \`${MIRROR_RESTORE_STATEMENT}\` ` +
        "antes de volver a ejecutar la suite",
    );
    assert.equal(
      probes.backup.error,
      null,
      `no se pudo comprobar ${MIRROR_BACKUP_TABLE}: ${probes.backup.error}`,
    );
  },
);
