import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

interface RegistryGroup {
  id: number;
  title: string;
  adminUserIds: Set<number>;
}

/**
 * Registro de los grupos donde este bot está presente como administrador.
 *
 * Se PERSISTE en `data/groups.json` (no es solo memoria): así los grupos
 * detectados sobreviven a reinicios del bot y no dependen de que cada
 * usuario usara /menu antes.
 *
 * IMPORTANTE: el registro solo ayuda a SABER qué grupos existen. NUNCA es
 * la fuente de autorización: cada operación se re-verifica en tiempo real
 * contra la API de Telegram mediante getChatMember(chat_id, user_id).
 */
const registry = new Map<number, RegistryGroup>();

function registryFilePath(): string {
  return resolve(process.cwd(), "data", "groups.json");
}

function loadRegistry(): void {
  try {
    const file = registryFilePath();
    if (!existsSync(file)) {
      return;
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      groups?: Array<{ id: number; title?: string; adminUserIds?: number[] }>;
    };
    const groups = raw.groups;
    if (!Array.isArray(groups)) {
      return;
    }
    for (const group of groups) {
      registry.set(group.id, {
        id: group.id,
        title: group.title ?? "",
        adminUserIds: new Set(group.adminUserIds ?? []),
      });
    }
    console.log(`[REGISTRO] Cargados ${registry.size} grupos desde disco.`);
  } catch (error) {
    console.error("[REGISTRO] No se pudo cargar el registro de grupos:", error);
  }
}

function saveRegistry(): void {
  const file = registryFilePath();
  const temporaryFile = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const groups = [...registry.values()].map((group) => ({
      id: group.id,
      title: group.title,
      adminUserIds: [...group.adminUserIds],
    }));
    writeFileSync(temporaryFile, JSON.stringify({ groups }, null, 2), "utf8");
    renameSync(temporaryFile, file);
  } catch (error) {
    console.error("[REGISTRO] No se pudo guardar el registro de grupos:", error);
    try {
      if (existsSync(temporaryFile)) {
        rmSync(temporaryFile);
      }
    } catch (cleanupError) {
      console.error("[REGISTRO] No se pudo limpiar el archivo temporal:", cleanupError);
    }
  }
}

loadRegistry();

/**
 * Registra o actualiza un grupo donde el bot está presente como
 * administrador. Se persiste en disco para sobrevivir a reinicios.
 */
export function registerGroup(chatId: number, title: string): void {
  const existing = registry.get(chatId);
  if (existing) {
    existing.title = title;
  } else {
    registry.set(chatId, { id: chatId, title, adminUserIds: new Set() });
  }
  saveRegistry();
}

/**
 * Elimina un grupo del registro (bot expulsado, fuera del grupo o
 * ya no administrador). También se persiste.
 */
export function unregisterGroup(chatId: number): void {
  registry.delete(chatId);
  saveRegistry();
}

/**
 * Anota que un usuario es administrador/creador de un grupo.
 * Se usa con la lista de administradores real (getChatAdministrators)
 * o cuando el usuario usa /menu dentro del grupo.
 */
export function markUserAsAdmin(chatId: number, userId: number): void {
  const group = registry.get(chatId);
  if (group) {
    group.adminUserIds.add(userId);
    saveRegistry();
  }
}

/**
 * Todos los grupos registrados donde el bot está presente como admin.
 * La autorización real se comprueba SIEMPRE aparte (getChatMember).
 */
export function getAllKnownGroups(): Array<{ id: number; title: string }> {
  return [...registry.values()].map((group) => ({
    id: group.id,
    title: group.title,
  }));
}

/**
 * Grupos conocidos donde el usuario figura como administrador según el
 * subíndice. Útil como punto de partida rápido; no es autoritativo.
 */
export function getUserKnownGroups(
  userId: number,
): Array<{ id: number; title: string }> {
  return [...registry.values()]
    .filter((group) => group.adminUserIds.has(userId))
    .map((group) => ({ id: group.id, title: group.title }));
}