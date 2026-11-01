import type { MyContext } from "../types.js";
import {
  getAllKnownGroups,
  getGroupCapabilities,
  unregisterGroup,
  updateRegisteredGroupCapabilities,
  updateRegisteredGroupTitle,
} from "../services/group-registry.js";
import { isUserAdminOf } from "./permissions.js";
import { invalidateSecurityCaches } from "./member-cache.js";

export interface AdministrableGroup {
  id: number;
  title: string;
}

function isBadRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "error_code" in error &&
    error.error_code === 400
  );
}

/**
 * Devuelve los grupos conocidos donde `ctx.from` es administrador o
 * creador.
 *
 * La lista de candidatos sale del registro persistido. La elegibilidad del
 * bot y del usuario se vuelve a consultar directamente en Telegram; el
 * registro nunca sustituye a la autorización actual.
 */
export async function getAdministrableGroups(
  ctx: MyContext,
  candidates?: AdministrableGroup[],
): Promise<AdministrableGroup[]> {
  if (!ctx.from) {
    return [];
  }

  const shouldReconcileRegistry = candidates === undefined;
  const candidateGroups = candidates ?? getAllKnownGroups();
  const result: AdministrableGroup[] = [];

  for (const group of candidateGroups) {
    let botMember;
    try {
      botMember = await ctx.api.getChatMember(group.id, ctx.me.id);
    } catch (error) {
      if (shouldReconcileRegistry && isBadRequest(error)) {
        unregisterGroup(group.id);
      } else {
        console.warn(
          `[GROUP_REGISTRY] No se pudo comprobar el estado de ZEUS en el chat error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      }
      continue;
    }

    if (botMember.status !== "administrator") {
      if (shouldReconcileRegistry) unregisterGroup(group.id);
      invalidateSecurityCaches(group.id);
      continue;
    }

    if (shouldReconcileRegistry) {
      updateRegisteredGroupCapabilities(
        group.id,
        getGroupCapabilities(botMember),
      );
    }

    let title = group.title;
    try {
      const currentChat = await ctx.api.getChat(group.id);
      if (
        (currentChat.type === "group" || currentChat.type === "supergroup") &&
        currentChat.title
      ) {
        title = currentChat.title;
        if (shouldReconcileRegistry) {
          updateRegisteredGroupTitle(group.id, title);
        }
      } else {
        if (shouldReconcileRegistry) unregisterGroup(group.id);
        continue;
      }
    } catch (error) {
      if (isBadRequest(error)) {
        if (shouldReconcileRegistry) unregisterGroup(group.id);
      } else {
        console.warn(
          `[GROUP_REGISTRY] No se pudo comprobar el tipo de chat error=${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      }
      continue;
    }

    invalidateSecurityCaches(group.id, ctx.from.id);
    if (await isUserAdminOf(ctx, group.id)) {
      result.push({
        id: group.id,
        title: title || `Grupo ${group.id}`,
      });
    }
  }

  return result.sort((a, b) => a.title.localeCompare(b.title));
}