import { Composer } from "grammy";
import { isGroupChat, isUserAdmin } from "../utils/permissions.js";
import {
  buildGroupPickerPanel,
  buildMainPanel,
} from "../menus/panels.js";
import {
  markUserAsAdmin,
  registerGroup,
} from "../services/group-registry.js";
import { getAdministrableGroups } from "../utils/groups.js";
import type { MyContext } from "../types.js";

export const menuCommand = new Composer<MyContext>();

menuCommand.command("menu", async (ctx) => {
  const from = ctx.from;
  const chat = ctx.chat;
  const username = ctx.me.username;

  if (ctx.message) {
    void ctx.deleteMessage().catch(() => {});
  }

  if (!from) {
    return;
  }

  try {
    if (isGroupChat(ctx)) {
      if (!(await isUserAdmin(ctx))) {
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
      await sendPrivatePanel(ctx, from.id, buildMainPanel(groupTitle));
      return;
    }

    const groups = await getAdministrableGroups(ctx);
    if (groups.length === 0) {
      return;
    }

    if (groups.length === 1) {
      const group = groups[0];
      ctx.session.user = {
        selectedGroupId: group.id,
        selectedGroupTitle: group.title,
      };
      await sendPrivatePanel(ctx, from.id, buildMainPanel(group.title));
      return;
    }

    await sendPrivatePanel(ctx, from.id, buildGroupPickerPanel(groups));
  } catch (error) {
    console.error(
      `[MENU] No se pudo autorizar o entregar el panel userId=${from.id} chatId=${chat.id} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
});

async function sendPrivatePanel(
  ctx: MyContext,
  userId: number,
  panel: ReturnType<typeof buildMainPanel>,
): Promise<void> {
  try {
    await ctx.api.sendMessage(userId, panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error(
      `[MENU] No se pudo entregar el panel privado userId=${userId} error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}