import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Inventario local de referencias de proyecto PROHIBIDAS y verificación de la
 * configuración de la suite PostgreSQL (Fase 4C, §1).
 *
 * Sustituye la lista codificada de un solo elemento del endurecimiento C7:
 *  - el inventario es un archivo versionado y documentado
 *    (`tests/fixtures/protected-project-refs.json`);
 *  - si el inventario no se puede leer o no es válido, la suite falla cerrado;
 *  - una referencia que NO aparece en el inventario no se considera segura por
 *    omisión: sólo es *candidata*, y la ejecución sigue exigiendo marcador y
 *    preflight de vaciedad (`positiveProofRequired`).
 *
 * Este módulo es puro respecto a la red: no crea clientes ni abre conexiones.
 */

export const PROJECT_REF_INVENTORY_VERSION = 1;

/** Ruta por defecto del inventario, relativa a este archivo. */
export const PROTECTED_REFS_INVENTORY_PATH = fileURLToPath(
  new URL("../fixtures/protected-project-refs.json", import.meta.url),
);

export interface ProtectedRefEntry {
  /** Referencia de proyecto (20 caracteres alfanuméricos en minúscula). */
  ref: string;
  /** Etiqueta legible, sin datos sensibles. */
  label: string;
  /** Motivo por el que está prohibida. */
  reason: string;
}

export interface ProtectedRefInventory {
  version: number;
  protectedRefs: ProtectedRefEntry[];
}

export interface InventoryLoaded {
  ok: true;
  inventory: ProtectedRefInventory;
  refs: ReadonlySet<string>;
  labels: ReadonlyMap<string, string>;
}

export interface InventoryFailed {
  ok: false;
  detail: string;
}

export type InventoryLoad = InventoryLoaded | InventoryFailed;

const REF_PATTERN = /^[a-z0-9]{20}$/;

/**
 * Valida el inventario de forma estricta. Cualquier desviación (versión
 * desconocida, entradas mal formadas, referencias duplicadas, lista vacía) es un
 * fallo: un inventario vacío equivaldría a "ningún proyecto está prohibido".
 */
export function parseProtectedRefInventory(raw: unknown): InventoryLoad {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: "el inventario no es un objeto JSON" };
  }
  const candidate = raw as { version?: unknown; protectedRefs?: unknown };
  if (candidate.version !== PROJECT_REF_INVENTORY_VERSION) {
    return {
      ok: false,
      detail:
        `versión de inventario no soportada (se esperaba ${PROJECT_REF_INVENTORY_VERSION}); ` +
        "actualizar tests/support/project-refs.ts junto con el archivo",
    };
  }
  if (!Array.isArray(candidate.protectedRefs) || candidate.protectedRefs.length === 0) {
    return {
      ok: false,
      detail:
        "protectedRefs debe ser un arreglo con al menos una referencia: un inventario vacío no protege nada",
    };
  }

  const entries: ProtectedRefEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of candidate.protectedRefs.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, detail: `protectedRefs[${index}] no es un objeto` };
    }
    const entry = item as Partial<Record<keyof ProtectedRefEntry, unknown>>;
    if (typeof entry.ref !== "string" || !REF_PATTERN.test(entry.ref.trim())) {
      return {
        ok: false,
        detail: `protectedRefs[${index}].ref no es una referencia de 20 caracteres [a-z0-9]`,
      };
    }
    const ref = entry.ref.trim();
    if (seen.has(ref)) {
      return { ok: false, detail: `protectedRefs[${index}].ref está duplicada` };
    }
    if (typeof entry.label !== "string" || entry.label.trim() === "") {
      return { ok: false, detail: `protectedRefs[${index}].label es obligatoria` };
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      return { ok: false, detail: `protectedRefs[${index}].reason es obligatoria` };
    }
    seen.add(ref);
    entries.push({ ref, label: entry.label.trim(), reason: entry.reason.trim() });
  }

  return {
    ok: true,
    inventory: { version: PROJECT_REF_INVENTORY_VERSION, protectedRefs: entries },
    refs: seen,
    labels: new Map(entries.map((entry) => [entry.ref, entry.label])),
  };
}

/** Carga el inventario desde disco. Nunca lanza: devuelve el motivo. */
export function loadProtectedRefInventory(path: string): InventoryLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      detail: `no se puede leer el inventario de referencias protegidas (${
        (error as NodeJS.ErrnoException).code ?? "error"
      })`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: "el inventario de referencias protegidas no es JSON válido" };
  }
  return parseProtectedRefInventory(parsed);
}

/**
 * Referencia declarada por la URL.
 *
 * Aceptado: exactamente `https://<ref>.supabase.co`, sin usuario/contraseña, sin
 * ruta y sin query. `<ref>` son 20 caracteres alfanuméricos en minúscula.
 *
 * Rechazado (no verificable): otros hosts (`*.supabase.in`, pooler, dominio
 * propio), `http`, y cualquier URL con ruta o query. En esos casos no se puede
 * comparar la referencia con la de la clave, así que se falla cerrado.
 */
export function projectRefFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (parsed.search || parsed.hash) return null;
  const match = /^([a-z0-9]{20})\.supabase\.co$/i.exec(parsed.hostname);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Referencia declarada por la clave, SIN imprimirla ni registrarla (§1: evitar
 * datos sensibles).
 *
 * Aceptado: `service_role` legacy en JWT de tres segmentos cuyo claim `role` sea
 * exactamente `service_role` y que declare la referencia en `ref` o en
 * `iss=https://<ref>.supabase.co/auth/v1`. El claim `role` es obligatorio
 * (hallazgo B4): sin él, una clave `anon` del mismo proyecto se aceptaba como
 * credencial de servicio.
 *
 * Rechazado (fail-closed): claves nuevas `sb_secret_*` / `sb_publishable_*`,
 * JWTs sin `role` o con otro `role`, payload no JSON y JWTs sin referencia.
 */
export function projectRefFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const claims = payload as { ref?: unknown; iss?: unknown; role?: unknown };
  if (claims.role !== "service_role") return null;
  if (typeof claims.ref === "string" && REF_PATTERN.test(claims.ref.trim())) {
    return claims.ref.trim().toLowerCase();
  }
  if (typeof claims.iss === "string") {
    const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/auth\/v1\/?$/i.exec(
      claims.iss.trim(),
    );
    if (match) return match[1].toLowerCase();
  }
  return null;
}

export type ProjectRefVerdict =
  | { kind: "protected"; ref: string; label: string }
  | { kind: "candidate"; ref: string }
  | { kind: "unverified"; detail: string };

/**
 * Clasifica una referencia frente al inventario.
 *
 * `candidate` significa "no está prohibida", NO "es segura": la autorización
 * real la dan el marcador del proyecto y el preflight de vaciedad. `unverified`
 * es un fallo cerrado (referencia ausente o mal formada).
 */
export function classifyProjectRef(
  ref: string | null,
  refs: ReadonlySet<string>,
  labels: ReadonlyMap<string, string> = new Map(),
): ProjectRefVerdict {
  if (!ref) {
    return { kind: "unverified", detail: "no se pudo derivar la referencia del proyecto" };
  }
  if (!REF_PATTERN.test(ref)) {
    return { kind: "unverified", detail: "la referencia no tiene el formato esperado" };
  }
  if (refs.has(ref)) {
    return { kind: "protected", ref, label: labels.get(ref) ?? "proyecto protegido" };
  }
  return { kind: "candidate", ref };
}

/** Variables que la suite exige para intentar ejecutarse. */
export const SUITE_ENV_KEYS = [
  "ZEUS_TEST_SUPABASE_URL",
  "ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY",
  "ZEUS_TEST_SUPABASE_DISPOSABLE",
  "ZEUS_TEST_GROUP_ID",
  "ZEUS_TEST_OPERATOR_ID",
] as const;

export interface SuiteEnvironment {
  readonly [key: string]: string | undefined;
}

export interface SuiteStaticConfig {
  url: string | null;
  /** Nunca se imprime ni se registra. */
  serviceRoleKey: string | null;
  projectRef: string | null;
  groupId: number;
  operatorId: number;
  disposable: boolean;
  /** Siempre `true`: marcador + preflight son la autorización real (§1, §2). */
  positiveProofRequired: true;
}

export interface StaticConfigVerdict {
  config: SuiteStaticConfig;
  blockers: string[];
  notices: string[];
}

/**
 * Evalúa la configuración estática (sin red) y devuelve bloqueos y avisos.
 *
 * Falla cerrado en todos los casos dudosos: inventario ilegible, URL no
 * verificable, clave sin `role=service_role`, referencia no coincidente o
 * proyecto de la lista protegida.
 */
export function evaluateStaticConfig(
  env: SuiteEnvironment,
  inventory: InventoryLoad,
): StaticConfigVerdict {
  const url = env.ZEUS_TEST_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = env.ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const disposable = env.ZEUS_TEST_SUPABASE_DISPOSABLE?.trim() === "yes";
  const groupId = Number(env.ZEUS_TEST_GROUP_ID ?? "0");
  const operatorId = Number(env.ZEUS_TEST_OPERATOR_ID ?? "0");
  const ambientUrl = env.SUPABASE_URL?.trim() ?? "";
  const ambientKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  const blockers: string[] = [];
  const notices: string[] = [];
  const refs = inventory.ok ? inventory.refs : new Set<string>();
  const labels = inventory.ok ? inventory.labels : new Map<string, string>();

  if (!inventory.ok) {
    blockers.push(
      `no se puede verificar el inventario de referencias protegidas: ${inventory.detail} ` +
        "(fallo cerrado: sin inventario no se autoriza ninguna ejecución)",
    );
  }

  if (!url || !serviceRoleKey) {
    blockers.push(
      "ZEUS_TEST_SUPABASE_URL / ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY no configuradas " +
        "(no se usan SUPABASE_URL ni SUPABASE_SERVICE_ROLE_KEY como respaldo)",
    );
  }
  if (!disposable) {
    blockers.push("ZEUS_TEST_SUPABASE_DISPOSABLE !== yes");
  }

  const urlRef = projectRefFromUrl(url);
  if (url && !urlRef) {
    blockers.push(
      "ZEUS_TEST_SUPABASE_URL no tiene el formato https://<ref>.supabase.co: " +
        "no se puede verificar el proyecto",
    );
  }
  const keyRef = projectRefFromKey(serviceRoleKey);
  if (serviceRoleKey && !keyRef) {
    blockers.push(
      "el formato de ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY no permite verificar la referencia " +
        "del proyecto (se acepta sólo una service_role legacy en JWT de 3 segmentos, " +
        "con role=service_role y claim ref o iss)",
    );
  }
  if (urlRef && keyRef && urlRef !== keyRef) {
    blockers.push("la clave service_role no corresponde al proyecto indicado por la URL");
  }

  const urlVerdict = classifyProjectRef(urlRef, refs, labels);
  if (urlVerdict.kind === "protected") {
    blockers.push(
      `la URL apunta a un proyecto protegido (${urlVerdict.label}): ` +
        "el inventario tests/fixtures/protected-project-refs.json lo prohíbe",
    );
  }
  const keyVerdict = classifyProjectRef(keyRef, refs, labels);
  if (keyVerdict.kind === "protected") {
    blockers.push(
      `la clave service_role pertenece a un proyecto protegido (${keyVerdict.label})`,
    );
  }
  if (urlVerdict.kind === "candidate") {
    notices.push(
      "la referencia del proyecto no está en el inventario local: no se considera segura " +
        "por omisión; la autorización depende del marcador y del preflight de vaciedad",
    );
  }

  if (url && ambientUrl && url === ambientUrl) {
    blockers.push(
      "ZEUS_TEST_SUPABASE_URL coincide con SUPABASE_URL (configuración de producción)",
    );
  }
  if (serviceRoleKey && ambientKey && serviceRoleKey === ambientKey) {
    blockers.push(
      "ZEUS_TEST_SUPABASE_SERVICE_ROLE_KEY es la misma que SUPABASE_SERVICE_ROLE_KEY " +
        "(credencial de producción)",
    );
  }
  if (ambientUrl || ambientKey) {
    notices.push(
      "hay SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY en el entorno: la suite no las usa " +
        "y sólo comprueba que no coincidan con las de prueba",
    );
  }

  if (!Number.isSafeInteger(groupId) || groupId === 0) {
    blockers.push("ZEUS_TEST_GROUP_ID no configurado");
  }
  if (!Number.isSafeInteger(operatorId) || operatorId <= 0) {
    blockers.push("ZEUS_TEST_OPERATOR_ID no configurado");
  }

  return {
    config: {
      url: url || null,
      serviceRoleKey: serviceRoleKey || null,
      projectRef: urlRef ?? keyRef,
      groupId,
      operatorId,
      disposable,
      positiveProofRequired: true,
    },
    blockers,
    notices,
  };
}


