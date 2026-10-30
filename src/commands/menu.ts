import { Composer, InlineKeyboard } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import { buildMainPanel } from "../menus/panels.js";
import {
  markUserAsAdmin,
  registerGroup,
} from "../services/group-registry.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import type { MyContext } from "../types.js";
import { COMMANDS } from "./definitions.js";
import { openPrivatePanel } from "../utils/private-panel.js";

export const menuCommand = new Composer<MyContext>();

menuCommand.command(COMMANDS.menu, async (ctx) => {
  const from = ctx.from;
  const chat = ctx.chat;

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
      if (sent) {
        await replySafely(
          ctx,
          "📩 Te he enviado el acceso al panel de ZEUS por privado.",
        );
        return;
      }

      const startLink = await getPrivatePanelStartLink(ctx);
      if (startLink) {
        await replySafely(
          ctx,
          "⛔ No pude enviar el panel directamente. Puedes abrir ZEUS por privado e intentarlo de nuevo.",
          new InlineKeyboard().url("Abrir ZEUS", startLink),
        );
      } else {
        await replySafely(
          ctx,
          "⛔ No pude enviar el panel ni obtener un enlace de ZEUS. Inténtalo de nuevo más tarde.",
        );
      }
      return;
    }
  } catch (error) {
    const detail = error instanceof Error
      ? error.name
      : "unknown";
    console.error(
      `[MENU] No se pudo autorizar o entregar el panel userId=${from.id} chatId=${chat.id} error=${detail}`,
    );
    await replySafely(
      ctx,
      "⚠️ No pude abrir el panel en este momento. Inténtalo de nuevo más tarde.",
    );
  }
});

const BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;

async function getPrivatePanelStartLink(ctx: MyContext): Promise<string | undefined> {
  let username = ctx.me?.username;
  if (!username) {
    try {
      username = (await ctx.api.getMe()).username;
    } catch (error) {
      console.error(
        `[MENU] No se pudo obtener el nombre del bot para el enlace error=${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
      return undefined;
    }
  }

  if (!username || !BOT_USERNAME_PATTERN.test(username)) {
    console.error("[MENU] No se pudo crear el enlace: nombre del bot no disponible o inválido.");
    return undefined;
  }

  return `https://t.me/${username}?start=menu`;
}

async function replySafely(
  ctx: MyContext,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  } catch (error) {
    console.error(
      `[MENU] No se pudo enviar la respuesta error=${
        error instanceof Error ? error.name : "unknown"
      }`,
    );
  }
}

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
      ? error.name
      : "unknown";
    console.error(
      `[MENU] No se pudo entregar el panel privado userId=${userId} error=${detail}`,
    );
    return false;
  }
}