import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Diario persistente de bindings deshabilitados por la suite PostgreSQL
 * (Fase 4C, §4).
 *
 * Problema que resuelve: `bindingsToRestore` vivía sólo en memoria. Si el proceso
 * muere (`kill -9`, cierre de la terminal, expiración del runner) el grupo
 * fixture queda sin bindings habilitados y ninguna ejecución posterior lo
 * detecta.
 *
 * Diseño:
 *  - antes de deshabilitar un binding se escribe en disco el estado ORIGINAL
 *    (`bot_id` + `enabled`), con `fsync` y renombrado atómico;
 *  - sólo después se ejecuta el `update`;
 *  - la restauración se considera completa cuando el `update` afectó 1 fila y
 *    una lectura posterior confirma `enabled = true`; entonces se retira la
 *    entrada;
 *  - `addBindingEntry` conserva el primer `previous_enabled` visto: deshabilitar
 *    dos veces no puede convertir "estaba habilitado" en "estaba deshabilitado".
 *
 * El archivo vive fuera de Git (`tests/.artifacts/`, ver `.gitignore`).
 */

export const BINDING_JOURNAL_VERSION = 1;

export interface BindingJournalEntry {
  /** `group_id` como texto: bigint se compara como cadena y nunca se redondea. */
  group_id: string;
  /** `bots.id` es uuid (CERBERO 001), no un entero. */
  bot_id: string;
  /** Estado exacto observado antes de deshabilitar. */
  previous_enabled: boolean;
  disabled_at: string;
  run_marker: string;
}

export interface BindingJournal {
  version: number;
  entries: BindingJournalEntry[];
}

export type JournalLoad =
  | { ok: true; journal: BindingJournal }
  | { ok: false; detail: string };

export type JournalWrite = { ok: true } | { ok: false; detail: string };

export function emptyJournal(): BindingJournal {
  return { version: BINDING_JOURNAL_VERSION, entries: [] };
}

export function defaultJournalPath(artifactsDir: string): string {
  return join(artifactsDir, "bindings-journal.json");
}

/** Valida el diario. Un archivo corrupto no se ignora: es un fallo cerrado. */
export function parseBindingJournal(raw: unknown): JournalLoad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: "el diario no es un objeto JSON" };
  }
  const candidate = raw as { version?: unknown; entries?: unknown };
  if (candidate.version !== BINDING_JOURNAL_VERSION) {
    return {
      ok: false,
      detail: `versión de diario no soportada (se esperaba ${BINDING_JOURNAL_VERSION})`,
    };
  }
  if (!Array.isArray(candidate.entries)) {
    return { ok: false, detail: "entries debe ser un arreglo" };
  }
  const entries: BindingJournalEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of candidate.entries.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, detail: `entries[${index}] no es un objeto` };
    }
    const entry = item as Partial<Record<keyof BindingJournalEntry, unknown>>;
    if (typeof entry.group_id !== "string" || !/^-?\d+$/.test(entry.group_id)) {
      return { ok: false, detail: `entries[${index}].group_id no es un entero en texto` };
    }
    if (typeof entry.bot_id !== "string" || entry.bot_id.trim() === "") {
      return { ok: false, detail: `entries[${index}].bot_id no es válido` };
    }
    if (typeof entry.previous_enabled !== "boolean") {
      return { ok: false, detail: `entries[${index}].previous_enabled no es booleano` };
    }
    if (typeof entry.disabled_at !== "string" || entry.disabled_at === "") {
      return { ok: false, detail: `entries[${index}].disabled_at es obligatorio` };
    }
    if (typeof entry.run_marker !== "string" || entry.run_marker === "") {
      return { ok: false, detail: `entries[${index}].run_marker es obligatorio` };
    }
    const key = `${entry.group_id}:${entry.bot_id}`;
    if (seen.has(key)) {
      return { ok: false, detail: `entries[${index}] está duplicada para el mismo binding` };
    }
    seen.add(key);
    entries.push({
      group_id: entry.group_id,
      bot_id: entry.bot_id,
      previous_enabled: entry.previous_enabled,
      disabled_at: entry.disabled_at,
      run_marker: entry.run_marker,
    });
  }
  return { ok: true, journal: { version: BINDING_JOURNAL_VERSION, entries } };
}

/** Lee el diario. Un archivo ausente es un diario vacío, no un error. */
export function readBindingJournal(path: string): JournalLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, journal: emptyJournal() };
    return {
      ok: false,
      detail: `no se puede leer el diario de bindings (${code ?? "error"})`,
    };
  }
  if (text.trim() === "") return { ok: true, journal: emptyJournal() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: "el diario de bindings no es JSON válido" };
  }
  return parseBindingJournal(parsed);
}

/**
 * Escribe el diario de forma durable: archivo temporal + `fsync` + renombrado
 * atómico. Si esto falla, el llamador NO debe deshabilitar el binding.
 */
export function writeBindingJournal(
  path: string,
  journal: BindingJournal,
): JournalWrite {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const handle = openSync(tmp, "w");
    try {
      writeFileSync(handle, `${JSON.stringify(journal, null, 2)}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(tmp, path);
    return { ok: true };
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // El temporal es best-effort: el fallo relevante es el original.
    }
    return {
      ok: false,
      detail: `no se puede escribir el diario de bindings (${
        (error as NodeJS.ErrnoException).code ?? "error"
      })`,
    };
  }
}

/**
 * Registra una entrada ANTES de deshabilitar el binding. Idempotente: si ya hay
 * una entrada para el mismo binding se conserva la original (no se pisa
 * `previous_enabled`).
 */
export function addBindingEntry(
  journal: BindingJournal,
  entry: BindingJournalEntry,
): { journal: BindingJournal; added: boolean } {
  const exists = journal.entries.some(
    (item) => item.group_id === entry.group_id && item.bot_id === entry.bot_id,
  );
  if (exists) return { journal, added: false };
  return {
    journal: {
      version: BINDING_JOURNAL_VERSION,
      entries: [...journal.entries, entry],
    },
    added: true,
  };
}

/** Retira una entrada ya restaurada y verificada. */
export function removeBindingEntry(
  journal: BindingJournal,
  groupId: string,
  botId: string,
): { journal: BindingJournal; removed: boolean } {
  const entries = journal.entries.filter(
    (item) => !(item.group_id === groupId && item.bot_id === botId),
  );
  return {
    journal: { version: BINDING_JOURNAL_VERSION, entries },
    removed: entries.length !== journal.entries.length,
  };
}


