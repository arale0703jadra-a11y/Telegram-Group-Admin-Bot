import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MAX_SECURITY_COMMAND_ATTEMPTS,
  MAX_SECURITY_COMMAND_RETRY_DEPTH,
  MUTE_MIN_REMAINING_MS,
} from "../src/services/security-command-recovery.js";

/**
 * Invariantes de las migraciones locales 020/021 (auditoría Fase 4C → fase 4D).
 *
 * Estas pruebas NO demuestran comportamiento en PostgreSQL: leen el SQL y fijan
 * las garantías que no pueden perderse en una edición futura. La verificación
 * real necesita un PostgreSQL desechable, que no existe en este entorno.
 *
 * Cubren:
 *   E2 — la purga excluye las tres referencias `command_id` con
 *        ON DELETE SET NULL (antes sólo comprobaba security_warnings).
 *   E3 — 'unknown' no se purga ni se reescribe automáticamente.
 *   E4 — techos internos no relajables en los parámetros de la RPC 021.
 *   E5 — `unique_violation` sólo es `already_retried` con ganador real.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(root, "supabase/migrations");

/** Quita comentarios de línea para no confundir documentación con SQL. */
function stripLineComments(sql: string): string {
  return sql
    .split(/\r?\n/u)
    .map((line) => {
      const index = line.indexOf("--");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

/** Normaliza espacios y mayúsculas para comparar SQL sin formato. */
function normalize(sql: string): string {
  return sql.toLowerCase().replace(/\s+/gu, " ").trim();
}

async function readMigration(name: string): Promise<{ raw: string; sql: string }> {
  const raw = await readFile(resolve(migrationsDir, name), "utf8");
  return { raw, sql: stripLineComments(raw) };
}

/** Cuerpo de una función, desde su cabecera hasta el `$$;` que la cierra. */
function functionBody(sql: string, name: string): string {
  const start = sql.toLowerCase().search(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "u"),
  );
  assert.notEqual(start, -1, `no se encontró la función ${name}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name}: cuerpo sin cerrar ($$;)`);
  return normalize(sql.slice(start, end));
}

const PURGE = "zeus_purge_security_commands";
const REQUEUE = "zeus_requeue_security_command";

test("020: la purga de órdenes respeta las tres referencias de auditoría (E2)", async () => {
  const { sql } = await readMigration("020_zeus_security_retention_and_rpcs.sql");
  const body = functionBody(sql, PURGE);

  // Cada referencia con FK ON DELETE SET NULL debe comprobarse con un NOT EXISTS
  // antes de borrar: el FK no conserva el vínculo, sólo lo vacía.
  for (const [table, alias] of [
    ["security_warnings", "w"],
    ["security_events", "e"],
    ["security_audit_log", "a"],
  ] as const) {
    assert.match(
      body,
      new RegExp(`not exists \\( select 1 from public\\.${table} as ${alias}\\b`, "u"),
      `la purga no excluye órdenes referenciadas por ${table}`,
    );
    assert.match(
      body,
      new RegExp(`${alias}\\.command_id = c\\.id`, "u"),
      `la comprobación de ${table} no compara command_id con la orden`,
    );
  }
});

test("020: la purga nunca toca processing ni unknown (E3)", async () => {
  const { sql } = await readMigration("020_zeus_security_retention_and_rpcs.sql");
  const body = functionBody(sql, PURGE);

  assert.match(
    body,
    /c\.result_state not in \('processing', 'unknown'\)/u,
    "falta la exclusión doble de processing/unknown",
  );

  // La lista de status debe seguir cerrada: si se abriera, un status nuevo
  // podría arrastrar órdenes no terminales.
  assert.match(
    body,
    /where s\.value not in \('completed', 'failed', 'cancelled'\)/u,
    "la lista de estados permitidos dejó de ser cerrada",
  );
});

test("020: la purga conserva sus suelos de retención y de lote", async () => {
  const { sql } = await readMigration("020_zeus_security_retention_and_rpcs.sql");
  const body = functionBody(sql, PURGE);

  assert.match(body, /p_older_than_days < 30/u, "el mínimo de 30 días desapareció");
  assert.match(body, /p_batch_limit < 1 or p_batch_limit > 5000/u, "el lote dejó de estar acotado");
  assert.match(body, /for update of c skip locked/u, "falta el bloqueo por lote");
});

test("020: el preflight verifica las columnas command_id que usa la purga", async () => {
  const { sql } = await readMigration("020_zeus_security_retention_and_rpcs.sql");

  for (const [table, origin] of [
    ["security_warnings", "004"],
    ["security_events", "003"],
    ["security_audit_log", "003/007"],
  ] as const) {
    assert.match(
      normalize(sql),
      new RegExp(
        `table_name = '${table}' and column_name = 'command_id'`,
        "u",
      ),
      `el preflight no comprueba ${table}.command_id (CERBERO ${origin})`,
    );
  }
});

test("la política documentada prohíbe purgar unknown y explica por qué (E3)", async () => {
  const policy = await readFile(resolve(root, "supabase/RETENTION_POLICY.md"), "utf8");

  assert.match(policy, /Nunca se purga automáticamente/u);
  assert.match(policy, /ON DELETE SET NULL/u);
  for (const table of ["security_warnings", "security_events", "security_audit_log"]) {
    assert.ok(policy.includes(table), `la política no menciona ${table}`);
  }
  assert.match(
    policy,
    /Neutralización definitiva sin reintento:[\s\S]{0,120}no está implementada/u,
    "la política debe dejar claro que no hay purga/neutralización automática",
  );
});

test("021: los techos internos coinciden con las constantes de ZEUS (E4)", async () => {
  const { sql } = await readMigration("021_zeus_security_command_requeue.sql");
  const body = functionBody(sql, REQUEUE);

  // Si alguien cambia una constante en TS y no en SQL (o al revés), esta prueba
  // falla: la política del panel y la de la base no pueden divergir.
  assert.match(
    body,
    new RegExp(`c_max_attempts constant integer := ${MAX_SECURITY_COMMAND_ATTEMPTS};`, "u"),
    "c_max_attempts no coincide con MAX_SECURITY_COMMAND_ATTEMPTS",
  );
  assert.match(
    body,
    new RegExp(
      `c_max_retry_depth constant integer := ${MAX_SECURITY_COMMAND_RETRY_DEPTH};`,
      "u",
    ),
    "c_max_retry_depth no coincide con MAX_SECURITY_COMMAND_RETRY_DEPTH",
  );
  assert.match(
    body,
    new RegExp(
      `c_mute_min_remaining_seconds constant integer := ${MUTE_MIN_REMAINING_MS / 1000};`,
      "u",
    ),
    "c_mute_min_remaining_seconds no coincide con MUTE_MIN_REMAINING_MS",
  );
});

test("021: los parámetros de política sólo pueden endurecer, nunca relajar (E4)", async () => {
  const { sql } = await readMigration("021_zeus_security_command_requeue.sql");
  const body = functionBody(sql, REQUEUE);

  // Recortes declarados.
  assert.match(
    body,
    /v_max_attempts := least\( greatest\(coalesce\(p_max_attempts, c_max_attempts\), 1\), c_max_attempts \);/u,
    "p_max_attempts dejó de recortarse contra el techo interno",
  );
  assert.match(
    body,
    /v_max_retry_depth := least\( greatest\(coalesce\(p_max_retry_depth, c_max_retry_depth\), 0\), c_max_retry_depth \);/u,
    "p_max_retry_depth dejó de recortarse contra el techo interno",
  );
  assert.match(
    body,
    /v_mute_min_remaining_seconds := least\( greatest\( coalesce\(p_mute_min_remaining_seconds, c_mute_min_remaining_seconds\), c_mute_min_remaining_seconds \), 86400 \);/u,
    "p_mute_min_remaining_seconds dejó de tener suelo interno",
  );

  // Las comprobaciones usan los valores recortados, no los parámetros crudos.
  assert.match(body, />= v_max_attempts/u, "attempts no usa el valor recortado");
  assert.match(body, />= v_max_retry_depth/u, "la profundidad no usa el valor recortado");
  assert.match(
    body,
    /v_until <= now\(\) \+ make_interval\( secs => v_mute_min_remaining_seconds \)/u,
    "el filtro de mute no usa la ventana mínima recortada",
  );
  for (const raw of [
    "p_max_attempts",
    "p_max_retry_depth",
    "p_mute_min_remaining_seconds",
  ]) {
    // Dos apariciones y sólo dos: la declaración del parámetro y la expresión de
    // recorte. Si reaparecen en la comparación, el llamador vuelve a mandar.
    const occurrences = body.split(raw).length - 1;
    assert.equal(occurrences, 2, `${raw} se usa fuera del recorte interno`);
  }
});

test("la suite PostgreSQL consume el inventario y no tiene referencias codificadas (E8)", async () => {
  const suiteSource = await readFile(
    resolve(root, "tests/security-command-requeue-postgres.test.ts"),
    "utf8",
  );
  const inventory = JSON.parse(
    await readFile(resolve(root, "tests/fixtures/protected-project-refs.json"), "utf8"),
  ) as { protectedRefs: Array<{ ref: string }> };

  // La protección debe venir del inventario versionado, no de una lista dentro
  // del archivo de pruebas: así se añade una referencia prohibida sin tocar el
  // código de la suite.
  assert.match(
    suiteSource,
    /loadProtectedRefInventory\(PROTECTED_REFS_INVENTORY_PATH\)/u,
    "la suite PostgreSQL dejó de cargar el inventario de referencias protegidas",
  );

  // Ninguna referencia del inventario puede estar escrita dentro de la suite:
  // sería la lista codificada de un solo elemento que C7/E8 elimina.
  for (const entry of inventory.protectedRefs) {
    assert.ok(
      !suiteSource.includes(entry.ref),
      "la suite PostgreSQL contiene una referencia protegida codificada",
    );
  }

  // Sin respaldo a variables de producción: la suite sólo lee ZEUS_TEST_*.
  assert.doesNotMatch(
    suiteSource,
    /process\.env\.SUPABASE_(?:URL|SERVICE_ROLE_KEY)/u,
    "la suite PostgreSQL lee variables de entorno SUPABASE_* (respaldo prohibido)",
  );
});

test("021: unique_violation no se informa como already_retried sin ganador (E5)", async () => {
  const { sql } = await readMigration("021_zeus_security_command_requeue.sql");
  const body = functionBody(sql, REQUEUE);

  assert.match(
    body,
    /get stacked diagnostics v_constraint_name = constraint_name;/u,
    "no se captura el nombre de la restricción violada",
  );
  const guard =
    /if v_existing_retry is null or \( v_constraint_name is not null and v_constraint_name <> 'security_commands_operation_key_idx' \) then raise; end if;/u;
  assert.match(body, guard, "falta la guarda que exige el índice de idempotencia y el ganador");

  const guardIndex = body.search(guard);
  // La última aparición es la del manejador de la excepción; antes existe la
  // comprobación previa de `already_retried` (sin excepción), que no se toca.
  const outcomeIndex = body.lastIndexOf("v_outcome := 'already_retried';");
  assert.notEqual(outcomeIndex, -1, "desapareció el resultado already_retried");
  assert.ok(
    guardIndex < outcomeIndex,
    "already_retried se informa antes de verificar la restricción y el ganador",
  );

  // El detalle ya no puede quedar vacío: sin ganador no hay nada que informar.
  assert.doesNotMatch(
    body,
    /v_detail := coalesce\(v_existing_retry::text, ''\);/u,
    "se volvió a permitir already_retried con detalle vacío",
  );
  assert.match(body, /v_detail := v_existing_retry::text;/u);
});

