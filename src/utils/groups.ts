import type { MyContext } from "../types.js";
import { getAllKnownGroups } from "../services/group-registry.js";
import { isUserAdminOf } from "./permissions.js";

export interface AdministrableGroup {
  id: number;
  title: string;
}

/**
 * Devuelve los grupos conocidos donde `ctx.from` es administrador o
 * creador.
 *
 * La lista de grupos candidatos sale del registro persistido (qué grupos
 * conoce el bot), pero la DECISIÓN se toma SIEMPRE comprobando en tiempo
 * real contra la API de Telegram con `getChatMember(chat_id, user_id)`.
 * Si el registro no contiene un grupo, el método no puede inventarlo.
 */
export async function getAdministrableGroups(
  ctx: MyContext,
  knownGroups = getAllKnownGroups(),
): Promise<AdministrableGroup[]> {
  if (!ctx.from) {
    return [];
  }

  const result: AdministrableGroup[] = [];

  for (const group of knownGroups) {
    // Fuente real de autorización: getChatMember contra el chat_id.
    if (await isUserAdminOf(ctx, group.id)) {
      result.push({
        id: group.id,
        title: group.title || `Grupo ${group.id}`,
      });
    }
  }

  return result.sort((a, b) => a.title.localeCompare(b.title));
}