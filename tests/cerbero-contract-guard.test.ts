import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Guardas estáticas del contrato de ejecución CERBERO ↔ ZEUS (FASE 4D-REVIEW-3).
 *
 * T-14 — Verifica que el repositorio canónico de CERBERO expone
 * `markCommandExecutionStarted` con sus seis fences, además de `completeCommand`,
 * `markCommandUnknown` y `renewCommandLease`. Lee el código fuente real (no usa
 * mocks). Si el árbol CERBERO no está disponible, la prueba se OMITE de forma
 * explícita y NO se declara el contrato como verificado.
 *
 * T-13 — Verifica la paridad de constantes entre la política TypeScript
 * (`src/services/security-command-recovery.ts`) y la RPC SQL
 * (`supabase/migrations/021_zeus_security_command_requeue.sql`): acciones
 * reintentables, intentos máximos, profundidad máxima, ventana mínima de mute y
 * sufijo de reintento. No introduce una segunda fuente de verdad: lee ambos
 * archivos tal cual están en el repositorio. Si un patrón esperado no se
 * encuentra, la prueba FALLA (nunca se omite) para forzar la revisión del
 * formato. Limitación: el análisis es textual; no evalúa ni ejecuta ninguno de
 * los dos artefactos.
 */

const CERBERO_COMMANDS_REPOSITORY_URL = new URL(
  "../../CERBERO/src/database/repositories/commands-repository.ts",
  import.meta.url,
);
const RECOVERY_POLICY_URL = new URL(
  "../src/services/security-command-recovery.ts",
  import.meta.url,
);
const REQUEUE_MIGRATION_URL = new URL(
  "../supabase/migrations/021_zeus_security_command_requeue.sql",
  import.meta.url,
);

function readIfPresent(url: URL): string | undefined {
  const path = fileURLToPath(url);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** Recorta el cuerpo de `export async function <name>(…)` hasta el siguiente `export`. */
function extractFunction(source: string, name: string): string | undefined {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const after = source.indexOf("export ", start + marker.length);
  const end = after === -1 ? source.length : after;
  return source.slice(start, end);
}

test("T-14: el repositorio canónico de CERBERO define el contrato de ejecución", (t) => {
  const source = readIfPresent(CERBERO_COMMANDS_REPOSITORY_URL);
  if (source === undefined) {
    t.skip(
      "CERBERO/src/database/repositories/commands-repository.ts no está " +
        "disponible en este workspace (árbol CERBERO ausente); no se declara el " +
        "contrato como verificado",
    );
    return;
  }

  const expectedFunctions = [
    "markCommandExecutionStarted",
    "completeCommand",
    "markCommandUnknown",
    "renewCommandLease",
  ] as const;
  for (const name of expectedFunctions) {
    assert.ok(
      source.includes(`export async function ${name}(`),
      `falta ${name} en el repositorio canónico de CERBERO`,
    );
  }

  const body = extractFunction(source, "markCommandExecutionStarted");
  assert.ok(body, "no se pudo extraer markCommandExecutionStarted");

  const fences = [
    '.eq("status", "processing")',
    '.eq("result_state", "processing")',
    '.eq("processing_instance_id", instanceId)',
    '.eq("processing_token", processingToken)',
    '.is("execution_started_at", null)',
    '.gt("lease_expires_at", now.toISOString())',
  ] as const;
  for (const fence of fences) {
    assert.ok(
      body.includes(fence),
      `markCommandExecutionStarted no contiene el fence ${fence}`,
    );
  }
});

test("T-13: paridad de constantes entre la política TS y la RPC SQL de reencolado", () => {
  const policy = readIfPresent(RECOVERY_POLICY_URL);
  const migration = readIfPresent(REQUEUE_MIGRATION_URL);
  assert.ok(policy, "src/services/security-command-recovery.ts no está presente");
  assert.ok(
    migration,
    "supabase/migrations/021_zeus_security_command_requeue.sql no está presente",
  );

  // 1) Acciones reintentables.
  const tsActions = (
    policy.match(/REPLAYABLE_SECURITY_ACTIONS[\s\S]*?=\s*\[([^\]]*)\]/)?.[1] ?? ""
  )
    .match(/"([A-Z_]+)"/g)
    ?.map((v) => v.replace(/"/g, ""))
    .sort() ?? [];
  const sqlActions = (
    migration.match(/v_allowed_actions\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/)?.[1] ?? ""
  )
    .match(/'([A-Z_]+)'/g)
    ?.map((v) => v.replace(/'/g, ""))
    .sort() ?? [];

  assert.ok(
    tsActions.length > 0,
    "no se extrajeron acciones reintentables de security-command-recovery.ts",
  );
  assert.ok(
    sqlActions.length > 0,
    "no se extrajeron acciones reintentables de 021_zeus_security_command_requeue.sql",
  );
  assert.equal(tsActions.length, 6, "REPLAYABLE_SECURITY_ACTIONS debe tener 6 acciones");
  assert.deepEqual(tsActions, sqlActions, "REPLAYABLE_SECURITY_ACTIONS ≠ v_allowed_actions");

  // 2) Intentos máximos.
  const tsAttempts = policy.match(/MAX_SECURITY_COMMAND_ATTEMPTS\s*=\s*(\d+)/)?.[1];
  const sqlAttempts = migration.match(/c_max_attempts\s+constant\s+integer\s*:=\s*(\d+)/)?.[1];
  assert.ok(tsAttempts, "MAX_SECURITY_COMMAND_ATTEMPTS no localizable en la política TS");
  assert.ok(sqlAttempts, "c_max_attempts no localizable en la migración 021");
  assert.equal(Number(tsAttempts), Number(sqlAttempts), "paridad de intentos máximos");

  // 3) Profundidad máxima.
  const tsDepth = policy.match(/MAX_SECURITY_COMMAND_RETRY_DEPTH\s*=\s*(\d+)/)?.[1];
  const sqlDepth = migration.match(/c_max_retry_depth\s+constant\s+integer\s*:=\s*(\d+)/)?.[1];
  assert.ok(tsDepth, "MAX_SECURITY_COMMAND_RETRY_DEPTH no localizable en la política TS");
  assert.ok(sqlDepth, "c_max_retry_depth no localizable en la migración 021");
  assert.equal(Number(tsDepth), Number(sqlDepth), "paridad de profundidad máxima");

  // 4) Ventana mínima de mute (TS en ms, SQL en segundos).
  const tsMute = policy.match(/MUTE_MIN_REMAINING_MS\s*=\s*([\d_]+)/)?.[1];
  const sqlMute = migration.match(
    /c_mute_min_remaining_seconds\s+constant\s+integer\s*:=\s*(\d+)/,
  )?.[1];
  assert.ok(tsMute, "MUTE_MIN_REMAINING_MS no localizable en la política TS");
  assert.ok(sqlMute, "c_mute_min_remaining_seconds no localizable en la migración 021");
  assert.equal(
    Number(tsMute.replace(/_/g, "")) / 1000,
    Number(sqlMute),
    "paridad de ventana mínima de mute (convertida a segundos)",
  );

  // 5) Sufijo de reintento.
  const tsSuffix = policy.match(/SECURITY_COMMAND_RETRY_SUFFIX\s*=\s*"([^"]+)"/)?.[1];
  const sqlSuffix = migration.match(/p_retry_key_suffix\s+text\s+default\s*'([^']+)'/)?.[1];
  assert.ok(tsSuffix, "SECURITY_COMMAND_RETRY_SUFFIX no localizable en la política TS");
  assert.ok(sqlSuffix, "p_retry_key_suffix no localizable en la migración 021");
  assert.equal(tsSuffix, sqlSuffix, "paridad del sufijo de reintento");
});