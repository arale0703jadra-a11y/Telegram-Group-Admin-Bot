import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Auditoría Fase 1 (permisos de funciones) y Fase 5 (migraciones revisables),
 * verificables sin base de datos.
 *
 * En PostgreSQL una función nace ejecutable por PUBLIC. En Supabase eso se
 * traduce en que una función `security definer` sin REVOKE queda invocable
 * desde PostgREST con la clave `anon`. Estas pruebas impiden que una migración
 * local futura reintroduzca ese agujero, y fijan la estructura de la 020, que
 * se corrompió al escribirse por partes (quedó un cuerpo de función abierto).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(root, "supabase/migrations");

/** Quita comentarios de línea para que la documentación no cuente como SQL. */
function stripLineComments(sql: string): string {
  return sql
    .split(/\r?\n/u)
    .map((line) => {
      const index = line.indexOf("--");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

async function readSql(name: string): Promise<{ raw: string; sql: string }> {
  const raw = await readFile(resolve(migrationsDir, name), "utf8");
  return { raw, sql: stripLineComments(raw) };
}

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

function declaredFunctions(sql: string): string[] {
  const names = new Set<string>();
  const pattern = /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/giu;
  for (const match of sql.matchAll(pattern)) names.add(match[1]);
  return [...names];
}

test("toda función local se revoca de public/anon/authenticated y se concede a service_role", async () => {
  const migrations = await listMigrations();
  assert.ok(migrations.length > 0, "no se encontraron migraciones locales");

  for (const name of migrations) {
    const { sql } = await readSql(name);
    for (const fn of declaredFunctions(sql)) {
      assert.match(
        sql,
        new RegExp(
          `revoke\\s+(?:all|execute)\\s+on\\s+function\\s+public\\.${fn}\\s*\\(`,
          "iu",
        ),
        `${name}: la función ${fn} no revoca EXECUTE de public/anon/authenticated`,
      );
      assert.match(
        sql,
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\(`,
          "iu",
        ),
        `${name}: la función ${fn} no concede EXECUTE explícitamente a service_role`,
      );
    }
  }
});

test("cada función SECURITY DEFINER fija un search_path seguro", async () => {
  for (const name of await listMigrations()) {
    const { sql } = await readSql(name);
    const definers = sql.match(/security\s+definer/giu) ?? [];
    const searchPaths = sql.match(/set\s+search_path/giu) ?? [];
    assert.equal(
      searchPaths.length,
      definers.length,
      `${name}: ${definers.length} funciones security definer pero ${searchPaths.length} search_path fijados`,
    );
  }
});

test("el entrecomillado $$ de cada migración queda cerrado", async () => {
  for (const name of await listMigrations()) {
    const { sql } = await readSql(name);
    const dollars = sql.match(/\$\$/gu) ?? [];
    assert.equal(
      dollars.length % 2,
      0,
      `${name}: número impar de delimitadores $$ (cuerpo de función sin cerrar)`,
    );
  }
});

test("020 declara las seis RPC/funciones previstas y no deja marcadores", async () => {
  const { raw, sql } = await readSql(
    "020_zeus_security_retention_and_rpcs.sql",
  );
  const expected = [
    "zeus_upsert_user_activity",
    "zeus_get_inactive_activity_candidates",
    "zeus_log_maintenance_run",
    "zeus_purge_security_commands",
    "zeus_purge_security_events",
    "zeus_purge_security_audit_log",
  ];
  assert.deepEqual(declaredFunctions(sql).sort(), [...expected].sort());
  assert.doesNotMatch(
    raw,
    /@@CHUNK|@@PART_/u,
    "quedaron marcadores de edición por partes",
  );
  assert.match(sql, /^\s*begin;/imu);
  assert.match(sql, /^\s*commit;/imu);
  // La tabla de mantenimiento se crea con RLS y permisos explícitos.
  assert.match(
    sql,
    /alter table public\.zeus_maintenance_runs enable row level security/iu,
  );
  assert.match(
    sql,
    /revoke all privileges on table public\.zeus_maintenance_runs\s+from public, anon, authenticated/iu,
  );
});

test("020 purga sólo estados terminales y nunca ejecuciones", async () => {
  const { sql } = await readSql("020_zeus_security_retention_and_rpcs.sql");
  assert.match(sql, /p_statuses is null or cardinality\(p_statuses\) = 0/iu);
  assert.match(
    sql,
    /where s\.value not in \('completed', 'failed', 'cancelled'\)/iu,
  );
  assert.match(sql, /c\.status = any\(p_statuses\)/iu);
  assert.match(sql, /c\.result_state not in \('processing', 'unknown'\)/iu);
  assert.match(sql, /from public\.security_warnings as w/iu);
  assert.match(sql, /for update of c skip locked/iu);
  assert.match(sql, /limit p_batch_limit/iu);
  // Ninguna purga puede alcanzar órdenes pendientes ni en ejecución.
  assert.doesNotMatch(sql, /status\s*=\s*'pending'/iu);
  assert.doesNotMatch(sql, /status\s*=\s*'processing'/iu);
});

test("020 exige retención mínima y lotes acotados en todas las purgas", async () => {
  const { sql } = await readSql("020_zeus_security_retention_and_rpcs.sql");
  for (const fn of [
    "zeus_purge_security_commands",
    "zeus_purge_security_events",
    "zeus_purge_security_audit_log",
  ]) {
    assert.match(
      sql,
      new RegExp(`${fn}: p_(?:older_than|retention)_days debe ser >= \\d+`, "iu"),
      `${fn}: falta la guarda de retención mínima`,
    );
    assert.match(
      sql,
      new RegExp(`${fn}: p_batch_limit entre 1 y 5000`, "iu"),
      `${fn}: falta la guarda de tamaño de lote`,
    );
  }
  // El registro de auditoría es el más protegido: nunca menos de 90 días.
  assert.match(sql, /p_retention_days is null or p_retention_days < 90/iu);
});

