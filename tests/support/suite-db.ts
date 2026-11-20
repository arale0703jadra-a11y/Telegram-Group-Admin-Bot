import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Capa mínima de acceso a datos para la infraestructura de la suite PostgreSQL
 * (`tests/security-command-requeue-postgres.test.ts`).
 *
 * Por qué existe (Fase 4C): el preflight, la recuperación de residuos, la
 * limpieza y la restauración de bindings tienen que poder probarse SIN
 * PostgreSQL. Con esta interfaz la lógica se ejecuta contra un doble de pruebas
 * y contra el cliente real, y las aserciones de las pruebas de integración
 * siguen usando `@supabase/supabase-js` directamente.
 *
 * Reglas de esta capa:
 *  - nunca imprime credenciales: los errores se describen con `describeSuiteError`;
 *  - las escrituras se hacen por identificadores exactos (`delete`/`update` con
 *    filtros) y DEVUELVEN las filas afectadas, para poder verificar el resultado;
 *  - `delete`/`update` exigen `.select("id")`, de modo que "0 filas" es
 *    observable y no una suposición.
 */

export interface PgErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Clases de error que la suite distingue explícitamente (Fase 4C, §5). */
export type SuiteErrorKind =
  | "missing_table"
  | "missing_column"
  | "permission"
  | "connection"
  | "unique_violation"
  | "other";

/** Códigos de PostgREST/PostgreSQL para "la tabla no existe". */
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set([
  "42P01", // undefined_table
  "PGRST205", // tabla ausente del esquema expuesto
]);

/** Códigos para "la columna no existe" (NO es lo mismo que tabla ausente). */
const MISSING_COLUMN_CODES: ReadonlySet<string> = new Set([
  "42703", // undefined_column
  "PGRST204", // columna ausente del esquema expuesto
]);

/** Códigos de permisos insuficientes (RLS, REVOKE, clave equivocada). */
const PERMISSION_CODES: ReadonlySet<string> = new Set([
  "42501", // insufficient_privilege
  "401", // JWT/credenciales rechazadas
  "403",
  "PGRST301",
  "PGRST302",
]);

/** Violación de unicidad (la usa la prueba del índice de `operation_key`). */
const UNIQUE_CODES: ReadonlySet<string> = new Set(["23505"]);

/** Síntomas de fallo de red. Nunca se confunden con "no hay nada que borrar". */
const CONNECTION_MESSAGE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|socket hang up|aborted|UND_ERR/i;

/**
 * Clasifica un error de PostgREST/PostgreSQL. `null` significa "no hubo error".
 *
 * Un error sin código y sin síntoma de red se clasifica como `other`, nunca como
 * "tabla ausente": tolerar por defecto convertiría un fallo real en un éxito.
 */
export function classifySuiteError(
  error: PgErrorLike | null | undefined,
): SuiteErrorKind | null {
  if (!error) return null;
  const code = (error.code ?? "").trim();
  if (MISSING_TABLE_CODES.has(code)) return "missing_table";
  if (MISSING_COLUMN_CODES.has(code)) return "missing_column";
  if (PERMISSION_CODES.has(code)) return "permission";
  if (UNIQUE_CODES.has(code)) return "unique_violation";
  if (CONNECTION_MESSAGE.test(error.message ?? "")) return "connection";
  return "other";
}

export function isMissingTableError(
  error: PgErrorLike | null | undefined,
): boolean {
  return classifySuiteError(error) === "missing_table";
}

/** JWT de tres segmentos (clave de servicio). */
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** URL de proyecto de Supabase (contiene la referencia). */
const PROJECT_URL_PATTERN = /https:\/\/[a-z0-9]{20}\.supabase\.co/gi;
/** Claves nuevas de Supabase (`sb_secret_*`, `sb_publishable_*`). */
const NEW_KEY_PATTERN = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/g;

/**
 * Elimina de un texto cualquier dato sensible que pudiera venir en un mensaje
 * de error. La suite sólo imprime diagnósticos, nunca credenciales.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(JWT_PATTERN, "<clave-redactada>")
    .replace(NEW_KEY_PATTERN, "<clave-redactada>")
    .replace(PROJECT_URL_PATTERN, "<url-redactada>");
}

/**
 * Descripción imprimible y acotada de un error: clase, código y mensaje
 * redactado. Es lo único que la suite muestra al operador.
 */
export function describeSuiteError(
  error: PgErrorLike | null | undefined,
): string {
  if (!error) return "sin error";
  const kind = classifySuiteError(error) ?? "other";
  const code = (error.code ?? "").trim() || "sin_codigo";
  const message = redactSecrets(
    (error.message ?? "").replace(/\s+/g, " ").trim(),
  ).slice(0, 240);
  return `${kind} (${code}): ${message || "sin mensaje"}`;
}

/** Filtros soportados por la suite. Deliberadamente pocos y explícitos. */
export type SuiteFilter =
  | { op: "eq"; column: string; value: string | number | boolean }
  | { op: "in"; column: string; values: readonly (string | number)[] }
  | { op: "like"; column: string; pattern: string }
  | { op: "is"; column: string; value: null | boolean }
  | { op: "gt"; column: string; value: string }
  | {
      op: "json";
      column: string;
      path: string;
      compare: "eq" | "like";
      value: string;
    };

export interface SuiteSelectOptions {
  columns?: string;
  filters?: readonly SuiteFilter[];
  /** Filas como máximo (PostgREST `limit`). */
  limit?: number;
  order?: { column: string; ascending?: boolean };
}

export interface SuiteResult<T> {
  data: T[] | null;
  error: PgErrorLike | null;
  count: number | null;
}

/**
 * Interfaz mínima usada por preflight/recuperación/limpieza/restauración.
 *
 * `delete` y `update` devuelven en `data` las filas afectadas: la suite verifica
 * cada escritura en lugar de asumir que ocurrió.
 */
export interface SuiteDb {
  /** `count` de filas que cumplen los filtros (head + count exact). */
  count(
    table: string,
    filters?: readonly SuiteFilter[],
  ): Promise<{ count: number | null; error: PgErrorLike | null }>;
  select<T>(
    table: string,
    options?: SuiteSelectOptions,
  ): Promise<SuiteResult<T>>;
  delete(
    table: string,
    filters: readonly SuiteFilter[],
  ): Promise<SuiteResult<{ id?: unknown }>>;
  update(
    table: string,
    values: Record<string, unknown>,
    filters: readonly SuiteFilter[],
  ): Promise<SuiteResult<{ id?: unknown }>>;
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<SuiteResult<T>>;
}

/** Subconjunto encadenable de PostgREST que el adaptador necesita. */
interface PostgrestChain extends PromiseLike<{
  data?: unknown;
  error?: PgErrorLike | null;
  count?: number | null;
}> {
  eq(column: string, value: unknown): PostgrestChain;
  in(column: string, values: readonly unknown[]): PostgrestChain;
  like(column: string, pattern: string): PostgrestChain;
  is(column: string, value: unknown): PostgrestChain;
  gt(column: string, value: unknown): PostgrestChain;
  filter(column: string, operator: string, value: unknown): PostgrestChain;
  limit(count: number): PostgrestChain;
  order(column: string, options?: { ascending?: boolean }): PostgrestChain;
  select(columns: string, options?: Record<string, unknown>): PostgrestChain;
}

function applyFilters(
  chain: PostgrestChain,
  filters: readonly SuiteFilter[] | undefined,
): PostgrestChain {
  let current = chain;
  for (const filter of filters ?? []) {
    switch (filter.op) {
      case "eq":
        current = current.eq(filter.column, filter.value);
        break;
      case "in":
        current = current.in(filter.column, filter.values);
        break;
      case "like":
        current = current.like(filter.column, filter.pattern);
        break;
      case "is":
        current = current.is(filter.column, filter.value);
        break;
      case "gt":
        current = current.gt(filter.column, filter.value);
        break;
      case "json":
        current = current.filter(
          `${filter.column}->>${filter.path}`,
          filter.compare,
          filter.value,
        );
        break;
    }
  }
  return current;
}

function asChain(value: unknown): PostgrestChain {
  return value as PostgrestChain;
}

interface RawResult {
  data?: unknown;
  error?: PgErrorLike | null;
  count?: number | null;
}

interface NormalizedResult {
  data: unknown[] | null;
  error: PgErrorLike | null;
  count: number | null;
}

function normalizeResult(result: RawResult): NormalizedResult {
  return {
    data: Array.isArray(result.data) ? (result.data as unknown[]) : null,
    error: result.error ?? null,
    count: typeof result.count === "number" ? result.count : null,
  };
}

/** Adaptador real sobre `@supabase/supabase-js`. */
export function createSupabaseSuiteDb(client: SupabaseClient): SuiteDb {
  return {
    async count(table, filters) {
      const chain = applyFilters(
        asChain(client.from(table).select("*", { count: "exact", head: true })),
        filters,
      );
      const result = normalizeResult(await chain);
      return { count: result.count, error: result.error };
    },

    async select<T>(table: string, options?: SuiteSelectOptions) {
      let chain = applyFilters(
        asChain(client.from(table).select(options?.columns ?? "*")),
        options?.filters,
      );
      if (options?.order) {
        chain = chain.order(options.order.column, {
          ascending: options.order.ascending ?? true,
        });
      }
      if (typeof options?.limit === "number") {
        chain = chain.limit(options.limit);
      }
      const result = normalizeResult(await chain);
      return {
        data: (result.data as T[] | null) ?? null,
        error: result.error,
        count: result.count,
      };
    },

    async delete(table, filters) {
      // `.select("id")` hace que PostgREST devuelva las filas borradas: así la
      // suite verifica el borrado en lugar de suponerlo.
      const chain = applyFilters(
        asChain(client.from(table).delete().select("id")),
        filters,
      );
      const result = normalizeResult(await chain);
      return {
        data: (result.data as Array<{ id?: unknown }> | null) ?? null,
        error: result.error,
        count: result.count,
      };
    },

    async update(table, values, filters) {
      const chain = applyFilters(
        asChain(client.from(table).update(values).select("id")),
        filters,
      );
      const result = normalizeResult(await chain);
      return {
        data: (result.data as Array<{ id?: unknown }> | null) ?? null,
        error: result.error,
        count: result.count,
      };
    },

    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const result = (await client.rpc(fn, args)) as RawResult;
      const data = Array.isArray(result.data)
        ? (result.data as T[])
        : result.data === null || result.data === undefined
          ? null
          : ([result.data] as T[]);
      return { data, error: result.error ?? null, count: null };
    },
  };
}

