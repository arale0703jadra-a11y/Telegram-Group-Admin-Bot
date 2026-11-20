import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addBindingEntry,
  readBindingJournal,
  writeBindingJournal,
} from "./support/binding-journal.js";
import {
  classifyProjectRef,
  evaluateStaticConfig,
  loadProtectedRefInventory,
  PROTECTED_REFS_INVENTORY_PATH,
  projectRefFromKey,
  projectRefFromUrl,
  type InventoryLoad,
} from "./support/project-refs.js";
import {
  classifySuiteError,
  createSupabaseSuiteDb,
  describeSuiteError,
  type PgErrorLike,
  type SuiteDb,
  type SuiteFilter,
  type SuiteResult,
  type SuiteSelectOptions,
} from "./support/suite-db.js";
import {
  cleanupFixtures,
  decidePreflight,
  disarmTestBindings,
  evaluateMirrorState,
  MIRROR_BACKUP_TABLE,
  observePreflight,
  recoverResiduals,
  restoreTestBindings,
  TEST_OPERATION_KEY_PREFIX,
  toMirrorProbe,
  type MirrorProbe,
  type SuiteSubject,
} from "./support/preflight.js";
import { evaluateSecurityCommandReplayPolicy } from "../src/services/security-command-recovery.js";

/**
 * Pruebas de la INFRAESTRUCTURA de la suite PostgreSQL (Fase 4C, §8).
 *
 * No abren conexiones ni leen `.env`: el preflight, la recuperación, la limpieza
 * y la restauración de bindings se ejecutan contra un doble de pruebas, y la
 * validación de entorno se ejecuta contra el inventario real del repositorio.
 */

const PRODUCTION_REF = "npruzbrrrvdrleslpivr";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** JWT sintético (firma irrelevante: sólo se decodifica el payload). */
function jwt(payload: Record<string, unknown>): string {
  return `${base64urlJson({ alg: "HS256", typ: "JWT" })}.${base64urlJson(payload)}.${"f".repeat(43)}`;
}

function serviceRoleKey(ref: string): string {
  return jwt({ role: "service_role", ref, iss: `https://${ref}.supabase.co/auth/v1` });
}

/** Entorno completo y correcto para un proyecto arbitrario. */
function validEnv(ref: string): Record<string, string> {
  return {
    ZEUS_TEST_SUPABASE_URL: `https://${ref}.supabase.co`,
    ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey(ref),
    ZEUS_TEST_SUPABASE_DISPOSABLE: "yes",
    ZEUS_TEST_GROUP_ID: "-1001234567890",
    ZEUS_TEST_OPERATOR_ID: "555",
  };
}

function loadInventory(): InventoryLoad {
  const inventory = loadProtectedRefInventory(PROTECTED_REFS_INVENTORY_PATH);
  assert.equal(inventory.ok, true, "el inventario del repositorio debe ser válido");
  return inventory;
}

const subject: SuiteSubject = {
  groupId: -1001234567890,
  operatorId: 555,
  runMarker: "zeus-it-1234abcd",
  testInstanceId: "zeus-integration-test",
  testBotName: "Cerbero",
  testBotType: "security",
  markerTable: "zeus_test_disposable_marker",
  journalPath: "",
};

type Row = Record<string, unknown>;

function likeMatch(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/%/g, ".*").replace(/_/g, ".")}$`);
  return regex.test(text);
}

function matches(row: Row, filters: readonly SuiteFilter[] = []): boolean {
  for (const filter of filters) {
    switch (filter.op) {
      case "eq":
        if (String(row[filter.column]) !== String(filter.value)) return false;
        break;
      case "in":
        if (!filter.values.map(String).includes(String(row[filter.column]))) return false;
        break;
      case "is": {
        const value = row[filter.column] === undefined ? null : row[filter.column];
        if (value !== filter.value) return false;
        break;
      }
      case "gt":
        if (!(String(row[filter.column]) > filter.value)) return false;
        break;
      case "like":
        if (!likeMatch(String(row[filter.column] ?? ""), filter.pattern)) return false;
        break;
      case "json": {
        const container = row[filter.column] as Record<string, unknown> | undefined;
        const raw = container ? container[filter.path] : undefined;
        const text = raw === undefined || raw === null ? "" : String(raw);
        if (filter.compare === "eq" ? text !== filter.value : !likeMatch(text, filter.value)) {
          return false;
        }
        break;
      }
    }
  }
  return true;
}

/**
 * Doble de `SuiteDb` con filtros reales y fallos inyectables.
 *
 * Reproduce la semántica que la suite necesita: `delete`/`update` devuelven las
 * filas afectadas, de modo que "0 filas" es observable igual que en PostgREST.
 */
class FakeDb implements SuiteDb {
  private readonly tables = new Map<string, Row[]>();
  private readonly failures = new Map<string, PgErrorLike>();
  private readonly onceFailures = new Map<string, PgErrorLike>();
  readonly ops: string[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(table, rows.map((row) => ({ ...row })));
    }
  }

  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }

  failOn(op: string, table: string, error: PgErrorLike): void {
    this.failures.set(`${op}:${table}`, error);
  }

  failOnce(op: string, table: string, error: PgErrorLike): void {
    this.onceFailures.set(`${op}:${table}`, error);
  }

  private check(op: string, table: string): PgErrorLike | null {
    this.ops.push(`${op}:${table}`);
    const once = this.onceFailures.get(`${op}:${table}`);
    if (once) {
      this.onceFailures.delete(`${op}:${table}`);
      return once;
    }
    return this.failures.get(`${op}:${table}`) ?? null;
  }

  async count(table: string, filters?: readonly SuiteFilter[]) {
    const error = this.check("count", table);
    if (error) return { count: null, error };
    return { count: this.rows(table).filter((row) => matches(row, filters)).length, error: null };
  }

  async select<T>(table: string, options?: SuiteSelectOptions): Promise<SuiteResult<T>> {
    const error = this.check("select", table);
    if (error) return { data: null, error, count: null };
    let rows = this.rows(table).filter((row) => matches(row, options?.filters));
    if (options?.order) {
      const column = options.order.column;
      const direction = options.order.ascending === false ? -1 : 1;
      rows = [...rows].sort((a, b) =>
        String(a[column] ?? "") < String(b[column] ?? "") ? -direction : direction,
      );
    }
    if (typeof options?.limit === "number") rows = rows.slice(0, options.limit);
    return { data: rows as T[], error: null, count: rows.length };
  }

  async delete(table: string, filters: readonly SuiteFilter[]) {
    const error = this.check("delete", table);
    if (error) return { data: null, error, count: null };
    const rows = this.rows(table);
    const removed = rows.filter((row) => matches(row, filters));
    this.tables.set(
      table,
      rows.filter((row) => !removed.includes(row)),
    );
    return { data: removed.map((row) => ({ id: row.id })), error: null, count: removed.length };
  }

  async update(table: string, values: Record<string, unknown>, filters: readonly SuiteFilter[]) {
    const error = this.check("update", table);
    if (error) return { data: null, error, count: null };
    const rows = this.rows(table).filter((row) => matches(row, filters));
    for (const row of rows) Object.assign(row, values);
    return { data: rows.map((row) => ({ id: row.id })), error: null, count: rows.length };
  }

  async rpc<T>(): Promise<SuiteResult<T>> {
    return { data: null, error: null, count: null };
  }
}

const TEST_BOT_ID = "b0000000-0000-4000-8000-000000000001";
const OTHER_BOT_ID = "b0000000-0000-4000-8000-000000000002";

function healthySeed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    zeus_test_disposable_marker: [{ note: "proyecto desechable" }],
    security_commands: [],
    bots: [
      {
        id: TEST_BOT_ID,
        instance_id: "zeus-integration-test",
        name: "Cerbero",
        type: "security",
        status: "offline",
        last_heartbeat_at: null,
      },
    ],
    group_bot_bindings: [{ group_id: subject.groupId, bot_id: TEST_BOT_ID, enabled: true }],
    security_events: [],
    security_audit_log: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §1. Referencias de proyecto
// ---------------------------------------------------------------------------

test("la referencia de producción del inventario bloquea la ejecución", () => {
  const inventory = loadInventory();
  const verdict = evaluateStaticConfig(validEnv(PRODUCTION_REF), inventory);

  assert.equal(verdict.config.positiveProofRequired, true);
  assert.ok(
    verdict.blockers.some((blocker) => blocker.includes("proyecto protegido")),
    `se esperaba un bloqueo por proyecto protegido: ${verdict.blockers.join(" | ")}`,
  );
});

test("el inventario del repositorio cubre la referencia de linked-project.json", (t) => {
  const inventory = loadInventory();
  if (!inventory.ok) throw new Error(inventory.detail);

  let linked: { ref?: unknown };
  try {
    linked = JSON.parse(
      readFileSync(new URL("../supabase/.temp/linked-project.json", import.meta.url), "utf8"),
    ) as { ref?: unknown };
  } catch (error) {
    // El artefacto es local (ignorado por Git): en un clon nuevo no existe.
    t.skip(
      `supabase/.temp/linked-project.json no está presente (${
        (error as NodeJS.ErrnoException).code ?? "error"
      }); el inventario sigue siendo la fuente de verdad`,
    );
    return;
  }

  assert.equal(typeof linked.ref, "string");
  assert.ok(
    inventory.refs.has(String(linked.ref)),
    "la referencia de supabase/.temp/linked-project.json debe estar en el inventario",
  );
});

test("una referencia desconocida no se considera segura por omisión", () => {
  const inventory = loadInventory();
  if (!inventory.ok) throw new Error(inventory.detail);
  const unknownRef = "zzzzzzzzzzzzzzzzzzzz";

  const classified = classifyProjectRef(unknownRef, inventory.refs, inventory.labels);
  assert.equal(classified.kind, "candidate");

  const verdict = evaluateStaticConfig(validEnv(unknownRef), inventory);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.config.positiveProofRequired, true);
  assert.ok(
    verdict.notices.some((notice) => notice.includes("no se considera segura")),
    "debe avisarse de que 'no prohibida' no equivale a 'segura'",
  );
});

test("una URL no verificable y una clave sin role=service_role fallan cerrado", () => {
  const inventory = loadInventory();

  const pooler = evaluateStaticConfig(
    {
      ...validEnv(PRODUCTION_REF),
      ZEUS_TEST_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.pooler.supabase.com:6543",
    },
    inventory,
  );
  assert.ok(
    pooler.blockers.some((blocker) => blocker.includes("no se puede verificar el proyecto")),
  );
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.pooler.supabase.com"), null);

  const anonKey = jwt({ role: "anon", ref: "abcdefghijklmnopqrst" });
  assert.equal(projectRefFromKey(anonKey), null);
  const anon = evaluateStaticConfig(
    { ...validEnv("abcdefghijklmnopqrst"), ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY: anonKey },
    inventory,
  );
  assert.ok(
    anon.blockers.some((blocker) => blocker.includes("role=service_role")),
  );
});

test("un inventario ilegible bloquea aunque el entorno parezca correcto", () => {
  const verdict = evaluateStaticConfig(validEnv("abcdefghijklmnopqrst"), {
    ok: false,
    detail: "no se puede leer el inventario de referencias protegidas (ENOENT)",
  });
  assert.ok(
    verdict.blockers.some((blocker) => blocker.includes("fallo cerrado")),
    verdict.blockers.join(" | "),
  );
});

test("la clave de prueba no se expone en diagnósticos redactados", () => {
  const key = serviceRoleKey("abcdefghijklmnopqrst");
  const description = describeSuiteError({
    code: "42501",
    message: `permission denied for key ${key} on https://abcdefghijklmnopqrst.supabase.co`,
  });
  assert.ok(!description.includes(key), "el JWT no debe aparecer en el diagnóstico");
  assert.ok(!description.includes("abcdefghijklmnopqrst.supabase.co"));
  assert.ok(description.includes("permission"));
});

// ---------------------------------------------------------------------------
// §2. Preflight de aislamiento
// ---------------------------------------------------------------------------

test("un proyecto con el marcador pero no vacío se rechaza", async () => {
  const db = new FakeDb(
    healthySeed({
      security_commands: [
        { id: "c-1", group_id: subject.groupId, operation_key: "ajena", status: "pending" },
      ],
    }),
  );

  const facts = await observePreflight(db, subject);
  const verdict = decidePreflight(facts, subject);

  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.blockers.some((blocker) => blocker.includes("no es exclusivo")),
    verdict.blockers.join(" | "),
  );
});

test("el marcador ausente o vacío impide ejecutar", async () => {
  const db = new FakeDb(healthySeed({ zeus_test_disposable_marker: [] }));
  const facts = await observePreflight(db, subject);
  const verdict = decidePreflight(facts, subject);

  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("está vacío")));
});

test("un error de lectura del marcador es bloqueo, no omisión", async () => {
  const db = new FakeDb(healthySeed());
  db.failOn("count", "zeus_test_disposable_marker", {
    code: "42501",
    message: "permission denied for table zeus_test_disposable_marker",
  });

  const verdict = decidePreflight(await observePreflight(db, subject), subject);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("permission")));
});

test("un bot con heartbeat reciente impide ejecutar", async () => {
  const db = new FakeDb(
    healthySeed({
      bots: [
        {
          id: TEST_BOT_ID,
          instance_id: "zeus-integration-test",
          name: "Cerbero",
          type: "security",
          status: "offline",
          last_heartbeat_at: new Date().toISOString(),
        },
      ],
    }),
  );

  const verdict = decidePreflight(await observePreflight(db, subject), subject);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("heartbeat reciente")));
});

// ---------------------------------------------------------------------------
// §4. Bindings: diario persistente y restauración verificable
// ---------------------------------------------------------------------------

function withTempJournal(): { subject: SuiteSubject; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zeus-guard-"));
  return {
    subject: { ...subject, journalPath: join(dir, "bindings-journal.json") },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("un binding de un bot ajeno impide ejecutar y nunca se deshabilita", async () => {
  const { subject: local, dispose } = withTempJournal();
  const db = new FakeDb(
    healthySeed({
      bots: [
        {
          id: TEST_BOT_ID,
          instance_id: "zeus-integration-test",
          name: "Cerbero",
          type: "security",
          status: "offline",
          last_heartbeat_at: null,
        },
        {
          id: OTHER_BOT_ID,
          instance_id: "otro-bot",
          name: "Afrodita",
          type: "assistant",
          status: "offline",
          last_heartbeat_at: null,
        },
      ],
      group_bot_bindings: [
        { group_id: local.groupId, bot_id: TEST_BOT_ID, enabled: true },
        { group_id: local.groupId, bot_id: OTHER_BOT_ID, enabled: true },
      ],
    }),
  );

  try {
    const verdict = decidePreflight(await observePreflight(db, local), local);
    assert.equal(verdict.ok, false);
    assert.ok(
      verdict.blockers.some((blocker) => blocker.includes("no son del entorno de pruebas")),
      verdict.blockers.join(" | "),
    );

    const disarm = await disarmTestBindings(db, local, [TEST_BOT_ID]);
    assert.deepEqual(disarm.blockers, []);
    assert.equal(disarm.disabled.length, 1);
    assert.deepEqual(
      db.rows("group_bot_bindings").map((row) => [row.bot_id, row.enabled]),
      [
        [TEST_BOT_ID, false],
        [OTHER_BOT_ID, true],
      ],
      "el binding del bot ajeno debe quedar intacto",
    );

    // El diario registra el estado ORIGINAL antes de deshabilitar.
    const journal = readBindingJournal(local.journalPath);
    assert.equal(journal.ok, true);
    if (!journal.ok) return;
    assert.equal(journal.journal.entries.length, 1);
    assert.equal(journal.journal.entries[0].bot_id, TEST_BOT_ID);
    assert.equal(journal.journal.entries[0].previous_enabled, true);
    assert.equal(journal.journal.entries[0].group_id, String(local.groupId));
  } finally {
    dispose();
  }
});

test("un diario corrupto bloquea el desarme en lugar de ignorarse", async () => {
  const { subject: local, dispose } = withTempJournal();
  try {
    const broken = writeBindingJournal(local.journalPath, {
      version: 1,
      // `previous_enabled` no booleano: diario inválido.
      entries: [{ group_id: "x", bot_id: TEST_BOT_ID } as never],
    });
    assert.equal(broken.ok, true);

    const db = new FakeDb(healthySeed());
    const disarm = await disarmTestBindings(db, local, [TEST_BOT_ID]);
    assert.ok(disarm.blockers.some((blocker) => blocker.includes("diario")));
    assert.equal(db.rows("group_bot_bindings")[0].enabled, true);
  } finally {
    dispose();
  }
});

test("la entrada del diario conserva el primer estado original observado", () => {
  const entry = {
    group_id: "1",
    bot_id: TEST_BOT_ID,
    previous_enabled: true,
    disabled_at: new Date().toISOString(),
    run_marker: "zeus-it-1234abcd",
  };
  const first = addBindingEntry({ version: 1, entries: [] }, entry);
  const second = addBindingEntry(first.journal, { ...entry, previous_enabled: false });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(second.journal.entries.length, 1);
  assert.equal(second.journal.entries[0].previous_enabled, true);
});

test("un error al restaurar bindings es bloqueo y la entrada permanece en el diario", async () => {
  const { subject: local, dispose } = withTempJournal();
  try {
    const written = writeBindingJournal(local.journalPath, {
      version: 1,
      entries: [
        {
          group_id: String(local.groupId),
          bot_id: TEST_BOT_ID,
          previous_enabled: true,
          disabled_at: new Date().toISOString(),
          run_marker: local.runMarker,
        },
      ],
    });
    assert.equal(written.ok, true);

    const db = new FakeDb(
      healthySeed({
        group_bot_bindings: [{ group_id: local.groupId, bot_id: TEST_BOT_ID, enabled: false }],
      }),
    );
    db.failOn("update", "group_bot_bindings", {
      code: "42501",
      message: "permission denied for table group_bot_bindings",
    });

    const report = await restoreTestBindings(db, local);
    assert.equal(report.restored, 0);
    assert.equal(report.pending, 1);
    assert.ok(report.blockers.some((blocker) => blocker.includes("no se pudo restaurar")));

    const journal = readBindingJournal(local.journalPath);
    assert.equal(journal.ok, true);
    if (journal.ok) {
      assert.equal(journal.journal.entries.length, 1, "la entrada no se retira sin verificar");
    }
  } finally {
    dispose();
  }
});

test("una restauración verificada retira la entrada y respeta el estado original", async () => {
  const { subject: local, dispose } = withTempJournal();
  try {
    const written = writeBindingJournal(local.journalPath, {
      version: 1,
      entries: [
        {
          group_id: String(local.groupId),
          bot_id: TEST_BOT_ID,
          previous_enabled: true,
          disabled_at: new Date().toISOString(),
          run_marker: local.runMarker,
        },
        {
          group_id: String(local.groupId),
          bot_id: OTHER_BOT_ID,
          previous_enabled: false,
          disabled_at: new Date().toISOString(),
          run_marker: local.runMarker,
        },
      ],
    });
    assert.equal(written.ok, true);

    const db = new FakeDb(
      healthySeed({
        group_bot_bindings: [
          { group_id: local.groupId, bot_id: TEST_BOT_ID, enabled: false },
          { group_id: local.groupId, bot_id: OTHER_BOT_ID, enabled: true },
        ],
      }),
    );

    const report = await restoreTestBindings(db, local);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.restored, 2);
    assert.deepEqual(
      db.rows("group_bot_bindings").map((row) => [row.bot_id, row.enabled]),
      [
        [TEST_BOT_ID, true],
        [OTHER_BOT_ID, false],
      ],
      "se restaura el estado EXACTO capturado, no 'enabled=true' por defecto",
    );

    const journal = readBindingJournal(local.journalPath);
    assert.equal(journal.ok, true);
    if (journal.ok) assert.deepEqual(journal.journal.entries, []);
  } finally {
    dispose();
  }
});

// ---------------------------------------------------------------------------
// §3. Recuperación de residuos
// ---------------------------------------------------------------------------

function residualRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    group_id: subject.groupId,
    operation_key: `${TEST_OPERATION_KEY_PREFIX}0000aaaa:${id}`,
    status: "pending",
    lease_expires_at: null,
    ...overrides,
  };
}

test("los residuos atribuibles se recuperan y los ajenos no se tocan", async () => {
  const db = new FakeDb(
    healthySeed({
      security_commands: [residualRow("res-1"), residualRow("res-2")],
      security_events: [
        {
          id: "ev-1",
          group_id: subject.groupId,
          event_type: "security_command_requeued",
          details: {
            reason: "prueba de integración zeus-it-0000aaaa",
            originalCommandId: "res-1",
          },
        },
        {
          id: "ev-2",
          group_id: subject.groupId,
          event_type: "security_command_requeued",
          details: { reason: "otro motivo", originalCommandId: "res-9" },
        },
      ],
      security_audit_log: [
        {
          id: "m-1",
          group_id: subject.groupId,
          action: "security_command_requeue",
          result: "reason=prueba de integración zeus-it-0000aaaa",
          command_id: "res-1",
        },
        {
          id: "m-2",
          group_id: subject.groupId,
          action: "security_command_requeue",
          result: "reason=operador: revisar a mano",
          command_id: "res-2",
        },
      ],
    }),
  );

  const initial = decidePreflight(await observePreflight(db, subject), subject);
  assert.equal(initial.ok, true, initial.blockers.join(" | "));
  assert.equal(initial.attributableResiduals.length, 2);
  assert.ok(initial.diagnostics.some((item) => item.includes("residuales")));

  const recovery = await recoverResiduals(db, subject, initial.attributableResiduals);
  assert.deepEqual(recovery.blockers, []);
  assert.equal(recovery.deletedCommands, 2);
  assert.equal(recovery.deletedEvents, 1, "sólo el evento atribuible a la suite");
  assert.equal(recovery.deletedMirrorRows, 1, "sólo el espejo atribuible a la suite");

  assert.deepEqual(
    db.rows("security_events").map((row) => row.id),
    ["ev-2"],
    "un evento con otro motivo no se borra",
  );
  assert.deepEqual(
    db.rows("security_audit_log").map((row) => row.id),
    ["m-2"],
    "un espejo con otro motivo no se borra",
  );

  const after = decidePreflight(await observePreflight(db, subject), subject, "post-recovery");
  assert.equal(after.ok, true, after.blockers.join(" | "));
  assert.equal(db.rows("security_commands").length, 0);
});

test("un residuo de otro grupo bloquea y nunca se borra", async () => {
  const db = new FakeDb(
    healthySeed({
      security_commands: [residualRow("res-otro", { group_id: subject.groupId + 1 })],
    }),
  );

  const verdict = decidePreflight(await observePreflight(db, subject), subject);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("OTRO grupo")));
  assert.deepEqual(verdict.attributableResiduals, []);

  const recovery = await recoverResiduals(db, subject, verdict.attributableResiduals);
  assert.deepEqual(recovery.blockers, []);
  assert.equal(db.rows("security_commands").length, 1, "el residuo ajeno sigue intacto");
});

test("un residuo con lease vigente es propiedad ambigua y bloquea", async () => {
  const db = new FakeDb(
    healthySeed({
      security_commands: [
        residualRow("res-vivo", {
          status: "processing",
          lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      ],
    }),
  );

  const verdict = decidePreflight(await observePreflight(db, subject), subject);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("lease vigente")));
  assert.deepEqual(verdict.attributableResiduals, []);
});

test("si un residuo no desaparece tras la recuperación, la suite no arranca", async () => {
  const db = new FakeDb(healthySeed({ security_commands: [residualRow("res-1")] }));

  const initial = decidePreflight(await observePreflight(db, subject), subject);
  const recovery = await recoverResiduals(db, subject, initial.attributableResiduals);
  assert.deepEqual(recovery.blockers, []);

  // Simula un escritor que vuelve a crear el residuo: la segunda decisión falla.
  db.rows("security_commands").push(residualRow("res-2"));
  const after = decidePreflight(await observePreflight(db, subject), subject, "post-recovery");
  assert.equal(after.ok, false);
  assert.ok(after.blockers.some((blocker) => blocker.includes("tras la recuperación")));
});

// ---------------------------------------------------------------------------
// §5. Limpieza verificada
// ---------------------------------------------------------------------------

const FIXTURE = {
  id: "cmd-orig-1",
  operationKey: `${TEST_OPERATION_KEY_PREFIX}0000aaaa:original`,
};
const RETRY_ID = "cmd-retry-1";

function cleanupSeed(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return healthySeed({
    security_commands: [
      {
        id: FIXTURE.id,
        group_id: subject.groupId,
        operation_key: FIXTURE.operationKey,
        status: "processing",
      },
      {
        id: RETRY_ID,
        group_id: subject.groupId,
        operation_key: `${FIXTURE.operationKey}#retry`,
        status: "pending",
      },
    ],
    security_events: [
      {
        id: "ev-1",
        group_id: subject.groupId,
        event_type: "security_command_requeued",
        details: { reason: "prueba", originalCommandId: FIXTURE.id },
      },
    ],
    security_audit_log: [
      {
        id: "m-1",
        group_id: subject.groupId,
        action: "security_command_requeue",
        result: `original=${FIXTURE.id} reason=prueba de integración ${subject.runMarker}`,
        command_id: RETRY_ID,
      },
    ],
    ...overrides,
  });
}

test("la limpieza borra todas las filas del fixture y no deja residuos", async () => {
  const db = new FakeDb(cleanupSeed());
  const report = await cleanupFixtures(db, subject, [FIXTURE]);

  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.residue, []);
  assert.deepEqual(report.deleted, { mirror: 1, events: 1, retries: 1, originals: 1 });
  assert.equal(db.rows("security_commands").length, 0);
  assert.equal(db.rows("security_events").length, 0);
  assert.equal(db.rows("security_audit_log").length, 0);
});

test("un espejo ausente es opcional; una columna ausente es bloqueo", async () => {
  const missingTable = new FakeDb(cleanupSeed());
  missingTable.failOn("delete", "security_audit_log", { code: "42P01" });
  const optional = await cleanupFixtures(missingTable, subject, [FIXTURE]);
  assert.deepEqual(optional.blockers, []);
  assert.ok(optional.diagnostics.some((item) => item.includes("espejo opcional")));

  const missingColumn = new FakeDb(cleanupSeed());
  missingColumn.failOn("delete", "security_audit_log", {
    code: "42703",
    message: 'column "command_id" does not exist',
  });
  const broken = await cleanupFixtures(missingColumn, subject, [FIXTURE]);
  assert.ok(
    broken.blockers.some((blocker) => blocker.includes("missing_column")),
    "una columna ausente NO puede tratarse como tabla ausente",
  );
  assert.equal(broken.residue.length, 0, "las órdenes se limpian igualmente");
});

test("un error al borrar eventos, reintentos u órdenes se reporta", async () => {
  const events = new FakeDb(cleanupSeed());
  events.failOn("delete", "security_events", { code: "42501", message: "denied" });
  const eventsReport = await cleanupFixtures(events, subject, [FIXTURE]);
  assert.ok(
    eventsReport.blockers.some((blocker) => blocker.includes("eventos")),
    eventsReport.blockers.join(" | "),
  );

  const retries = new FakeDb(cleanupSeed());
  retries.failOnce("delete", "security_commands", { code: "42501", message: "denied" });
  const retryReport = await cleanupFixtures(retries, subject, [FIXTURE]);
  assert.ok(retryReport.blockers.some((blocker) => blocker.includes("reintentos")));
  assert.ok(retryReport.residue.length > 0, "un reintento vivo es un residuo declarado");

  const orders = new FakeDb(
    cleanupSeed({
      security_commands: [
        {
          id: FIXTURE.id,
          group_id: subject.groupId,
          operation_key: FIXTURE.operationKey,
          status: "processing",
        },
      ],
    }),
  );
  orders.failOn("delete", "security_commands", { code: "42501", message: "denied" });
  const ordersReport = await cleanupFixtures(orders, subject, [FIXTURE]);
  assert.ok(
    ordersReport.blockers.some((blocker) => blocker.includes("no se pudo borrar la orden")),
    ordersReport.blockers.join(" | "),
  );
  assert.ok(ordersReport.residue.length > 0, "la orden que no se pudo borrar es un residuo");
});

// ---------------------------------------------------------------------------
// §6. Escenarios del espejo (M3) y coherencia TS/SQL (B1)
// ---------------------------------------------------------------------------

const PRESENT: MirrorProbe = { present: true, error: null };
const ABSENT: MirrorProbe = { present: false, error: null };

test("el escenario por defecto omite el renombrado y no contradice la higiene", () => {
  const verdict = evaluateMirrorState({ scenario: "default", main: PRESENT, backup: ABSENT });
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.runRenameScenario, false);
  assert.ok(verdict.skipReason && verdict.skipReason.includes("ZEUS_TEST_SCENARIO"));

  // Un proyecto sin espejo es válido: la tabla es opcional.
  const withoutMirror = evaluateMirrorState({
    scenario: "default",
    main: ABSENT,
    backup: ABSENT,
  });
  assert.deepEqual(withoutMirror.blockers, []);
  assert.ok(withoutMirror.diagnostics.some((item) => item.includes("opcional")));
});

test("el escenario de renombrado exige el estado preparado por el operador", () => {
  const prepared = evaluateMirrorState({
    scenario: "audit-log-rename",
    main: ABSENT,
    backup: PRESENT,
  });
  assert.deepEqual(prepared.blockers, []);
  assert.equal(prepared.runRenameScenario, true);
  assert.equal(prepared.skipReason, null);
  assert.ok(prepared.diagnostics.some((item) => item.includes("restaurar")));

  const notPrepared = evaluateMirrorState({
    scenario: "audit-log-rename",
    main: PRESENT,
    backup: ABSENT,
  });
  assert.equal(notPrepared.runRenameScenario, false);
  assert.ok(
    notPrepared.blockers.some((blocker) => blocker.includes("NO exista")),
    notPrepared.blockers.join(" | "),
  );
});

test("un backup del espejo preexistente bloquea con la sentencia de restauración", () => {
  const verdict = evaluateMirrorState({
    scenario: "default",
    main: ABSENT,
    backup: PRESENT,
  });
  assert.equal(verdict.runRenameScenario, false);
  assert.ok(
    verdict.blockers.some((blocker) =>
      blocker.includes(`rename to ${MIRROR_BACKUP_TABLE.replace("_zeus_test_backup", "")}`),
    ),
    verdict.blockers.join(" | "),
  );
});

test("una sonda del espejo no verificable es bloqueo y 'tabla ausente' no lo es", () => {
  assert.deepEqual(toMirrorProbe({ error: null }), { present: true, error: null });
  assert.deepEqual(toMirrorProbe({ error: { code: "42P01" } }), {
    present: false,
    error: null,
  });
  assert.equal(toMirrorProbe({ error: { code: "42501", message: "denied" } }).error !== null, true);

  const verdict = evaluateMirrorState({
    scenario: "default",
    main: { present: false, error: "permission (42501): denied" },
    backup: ABSENT,
  });
  assert.ok(verdict.blockers.some((blocker) => blocker.includes("no se puede comprobar")));
});

test("la política TS rechaza until_date nulo igual que la RPC 021", () => {
  // 021 compara `jsonb_typeof(payload -> 'until_date') <> 'number'`: una clave
  // PRESENTE con valor null es `temporal_window_expired`, no "sin ventana".
  const base = {
    action: "MUTE_USER" as const,
    status: "processing" as const,
    resultState: "processing" as const,
    executionStartedAt: null,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    processingAt: new Date(Date.now() - 120_000).toISOString(),
    attempts: 1,
    operationKey: "parity-key",
    acknowledged: true,
    now: Date.now(),
  };

  const nullWindow = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: { until_date: null },
  });
  assert.equal(nullWindow.allowed, false);
  assert.equal(nullWindow.reason, "temporal_window_expired");

  const absentWindow = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: { reason: "mute sin ventana" },
  });
  assert.equal(absentWindow.allowed, true, "sin la clave, ambas implementaciones permiten");

  const stringWindow = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: { until_date: "1700000000" as never },
  });
  assert.equal(stringWindow.allowed, false);
  assert.equal(stringWindow.reason, "temporal_window_expired");
});

test("la clasificación de errores distingue tabla, columna, permisos y red", () => {
  assert.equal(classifySuiteError(null), null);
  assert.equal(classifySuiteError({ code: "42P01" }), "missing_table");
  assert.equal(classifySuiteError({ code: "PGRST205" }), "missing_table");
  assert.equal(classifySuiteError({ code: "42703" }), "missing_column");
  assert.equal(classifySuiteError({ code: "42501" }), "permission");
  assert.equal(classifySuiteError({ code: "23505" }), "unique_violation");
  assert.equal(classifySuiteError({ message: "TypeError: fetch failed" }), "connection");
  assert.equal(classifySuiteError({ code: "57014", message: "canceled" }), "other");
});


test("una interrupción durante la limpieza se puede retomar", async () => {
  const db = new FakeDb(cleanupSeed());
  db.failOnce("delete", "security_commands", {
    code: "57014",
    message: "canceling statement due to user request",
  });

  const interrupted = await cleanupFixtures(db, subject, [FIXTURE]);
  assert.ok(interrupted.blockers.length > 0, "la interrupción no puede pasar inadvertida");
  assert.ok(interrupted.residue.length > 0);

  const resumed = await cleanupFixtures(db, subject, [FIXTURE]);
  assert.deepEqual(resumed.blockers, []);
  assert.deepEqual(resumed.residue, []);
  assert.equal(db.rows("security_commands").length, 0);
});



