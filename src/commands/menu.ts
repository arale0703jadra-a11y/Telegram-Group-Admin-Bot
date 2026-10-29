import { Composer } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import { buildMainPanel } from "../menus/panels.js";
import {
  markUserAsAdmin,
  registerGroup,
} from "../services/group-registry.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import { sanitizeLogText } from "../utils/safety.js";
import type { MyContext } from "../types.js";
import { COMMANDS } from "./definitions.js";
import { openPrivatePanel } from "../utils/private-panel.js";

export const menuCommand = new Composer<MyContext>();

menuCommand.command(COMMANDS.menu, async (ctx) => {
  const from = ctx.from;
  const chat = ctx.chat;
  const username = ctx.me.username;

  if (ctx.message && chat.type === "private") {
    void ctx.deleteMessage().catch((error: unknown) => {
      console.warn(
        `[COMMAND_DELETE] No se pudo borrar /menu privado userId=${from?.id ?? "unknown"} ` +
          `error=${error instanceof Error ? error.name : "unknown"}`,
      );
    });
  }

  if (!from) {
    return;
  }

  try {
    if (chat.type === "private") {
      await openPrivatePanel(ctx);
      return;
    }

    if (!(await isAuthorizedPanelUser(from.id))) {
      return;
    }

    if (isGroupChat(ctx)) {
      if (!(await isUserAdmin(ctx))) {
        await ctx
          .reply("⛔ Este comando solo está disponible para administradores del grupo.")
          .catch(() => undefined);
        return;
      }

      const groupId = chat.id;
      const groupTitle = chat.title ?? "";
      ctx.session.user = {
        selectedGroupId: groupId,
        selectedGroupTitle: groupTitle,
      };
      registerGroup(groupId, groupTitle);
      markUserAsAdmin(groupId, from.id);
      const sent = await sendPrivatePanel(ctx, from.id, buildMainPanel(groupTitle));
      if (!sent) {
        await ctx
          .reply(
            "⛔ No pude enviarte el panel por privado. Escríbeme primero con /start en privado y vuelve a usar /menu aquí.",
          )
          .catch(() => undefined);
      }
      return;
    }
  } catch (error) {
    const detail = error instanceof Error
      ? sanitizeLogText(`${error.name}: ${error.message}`)
      : "unknown";
    console.error(
      `[MENU] No se pudo autorizar o entregar el panel userId=${from.id} chatId=${chat.id} error=${detail}`,
    );
    await ctx
      .reply("⚠️ No pude abrir el panel en este momento. Inténtalo de nuevo más tarde.")
      .catch(() => undefined);
  }
});

async function sendPrivatePanel(
  ctx: MyContext,
  userId: number,
  panel: ReturnType<typeof buildMainPanel>,
): Promise<boolean> {
  try {
    await ctx.api.sendMessage(userId, panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error
      ? sanitizeLogText(`${error.name}: ${error.message}`)
      : "unknown";
    console.error(
      `[MENU] No se pudo entregar el panel privado userId=${userId} error=${detail}`,
    );
    return false;
  }
}