import { Composer } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getGroupData } from "../storage/index.js";
import {
  getTrackedUser,
  getUserCard,
  resolveUserTrigger,
  searchObservedUsers,
} from "../utils/users.js";
import {
  buildBanConfirmPanel,
  buildMuteMenuPanel,
  buildUserCardPanel,
  buildUserSearchResultsPanel,
  buildWarningsPanel,
  type Panel,
} from "../menus/panels.js";
import { muteUser, unmuteUser, warnUser } from "../moderation/actions.js";
import type { MyContext, PickAction } from "../types.js";

const MAX_MUTE_MINUTES = 527040;

/**
 * Asistente de entrada libre del panel privado.
 *
 * Tras pulsar "Buscar usuario", "Silenciar", etc., el bot pide el
 * @usuario o ID y lo resuelve con el siguiente mensaje de texto.
 */
export const privateInput = new Composer<MyContext>();

privateInput.on("message:text", async (ctx) => {
  if (ctx.chat?.type !== "private" || !ctx.from || !ctx.message) {
    return;
  }

  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) {
    return; // Los comandos (/start, /menu…) siguen su flujo normal.
  }

  const pending = ctx.session.user.pendingAction;
  if (!pending) {
    return;
  }
  console.log(
    `[PRIVATE INPUT] received userId=${ctx.from.id} ` +
      `pendingKind=${pending.kind} text=${JSON.stringify(text.slice(0, 120))}`,
  );

  // Se re-verifica SIEMPRE la autorización contra el grupo de la acción.
  if (!(await isUserAdminOf(ctx, pending.groupId))) {
    ctx.session.user.pendingAction = undefined;
    await ctx.reply("⛔ Ya no eres administrador de ese grupo.");
    return;
  }

  try {
    if (pending.kind === "muteMinutes") {
      const handled = await handleMuteMinutes(
        ctx,
        pending.groupId,
        pending.userId,
        text,
      );
      if (handled) {
        ctx.session.user.pendingAction = undefined;
      }
      return;
    }
    if (pending.kind === "warnReason") {
      await handleWarnReason(ctx, pending.groupId, pending.userId, text);
      ctx.session.user.pendingAction = undefined;
      return;
    }
    if (pending.kind === "search") {
      await handleSearch(ctx, pending.groupId, text);
      ctx.session.user.pendingAction = undefined;
      console.log("[USER SEARCH] pending cleared");
      return;
    }
    if (pending.kind === "pick") {
      const handled = await handlePick(
        ctx,
        pending.groupId,
        pending.action,
        text,
      );
      if (handled) {
        ctx.session.user.pendingAction = undefined;
      }
      return;
    }
  } catch (error) {
    console.error("[PRIVADO] Error al procesar la entrada:", error);
    await ctx.reply("⚠️ Algo falló al procesar tu mensaje. Inténtalo de nuevo.");
  }
});

async function handleWarnReason(
  ctx: MyContext,
  groupId: number,
  userId: number,
  reason: string,
): Promise<void> {
  const data = await getGroupData(groupId);
  const tracked = getTrackedUser(data, userId);
  const result = await warnUser(
    ctx,
    groupId,
    userId,
    formatName(tracked),
    reason,
  );
  await ctx.reply(
    result.ok ? "⚠️ Advertencia añadida." : `⛔ ${result.error}`,
  );
  if (result.ok) {
    await sendPanel(ctx, buildUserCardPanel(await getUserCard(ctx, groupId, userId)));
  }
}

async function handlePick(
  ctx: MyContext,
  groupId: number,
  action: PickAction,
  text: string,
): Promise<boolean> {
  if (action === "search") {
    console.log(`[USER SEARCH] query=${JSON.stringify(text.slice(0, 120))}`);
  }

  const user = await resolveUserTrigger(ctx, groupId, text);
  if (!user) {
    if (action === "search") {
      console.log("[USER SEARCH] result=not-found");
    }
    await ctx.reply(
      "🔎 No encuentro a ese usuario en los usuarios observados de este grupo.\n\n" +
        "Usa un Telegram ID consultable por el bot o un @username que ya haya " +
        "sido observado en este grupo.",
    );
    return false;
  }
  if (action === "search") {
    console.log(`[USER SEARCH] result=found userId=${user.id}`);
  }

  switch (action) {
    case "search": {
      const panel = buildUserCardPanel(await getUserCard(ctx, groupId, user.id));
      await sendPanel(ctx, panel);
      return true;
    }
    case "warn": {
      const data = await getUserCard(ctx, groupId, user.id);
      await sendPanel(
        ctx,
        buildWarningsPanel(user, data.warnings, data.warnLimit),
      );
      return true;
    }
    case "mute": {
      await sendPanel(ctx, buildMuteMenuPanel(user));
      return true;
    }
    case "ban": {
      await sendPanel(ctx, buildBanConfirmPanel(user));
      return true;
    }
    case "unmute": {
      const result = await unmuteUser(ctx, groupId, user.id, formatName(user));
      await ctx.reply(result.ok ? "🔊 Silencio eliminado." : `⛔ ${result.error}`);
      if (result.ok) {
        await sendPanel(ctx, buildUserCardPanel(await getUserCard(ctx, groupId, user.id)));
      }
      return true;
    }
  }

}

async function handleSearch(
  ctx: MyContext,
  groupId: number,
  text: string,
): Promise<void> {
  console.log(`[USER SEARCH] query=${JSON.stringify(text.slice(0, 120))}`);
  try {
    const users = await searchObservedUsers(ctx, groupId, text);
    if (users.length === 0) {
      console.log("[USER SEARCH] result=not-found");
      await ctx.reply(
        "❌ No encontré ese usuario entre los usuarios observados por el bot.\n\n" +
          "Usa un Telegram ID consultable por el bot o un @username observado en este grupo.",
      );
      return;
    }

    console.log(`[USER SEARCH] result=found count=${users.length}`);
    if (users.length > 1) {
      await sendPanel(ctx, buildUserSearchResultsPanel(users));
      return;
    }
    const user = users[0];
    if (!user) {
      return;
    }
    await sendPanel(ctx, buildUserCardPanel(await getUserCard(ctx, groupId, user.id)));
  } catch (error) {
    console.error("[USER SEARCH] result=error", error);
    await ctx.reply("⚠️ No se pudo completar la búsqueda. Inténtalo de nuevo.");
  }
}

async function handleMuteMinutes(
  ctx: MyContext,
  groupId: number,
  userId: number,
  text: string,
): Promise<boolean> {
  const minutes = Number(text.replace(/\D/g, ""));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MUTE_MINUTES) {
    await ctx.reply(
      `⏱️ Escribe una duración válida en minutos (1 – ${MAX_MUTE_MINUTES}).`,
    );
    return false;
  }

  const data = await getGroupData(groupId);
  const tracked = getTrackedUser(data, userId);
  const who = tracked.name || tracked.username;

  const result = await muteUser(ctx, groupId, userId, minutes, who);
  await ctx.reply(
    result.ok
      ? `🔇 Usuario silenciado durante ${minutes} min. Telegram restaura sus permisos al terminar.`
      : `⛔ ${result.error}`,
  );
  if (result.ok) {
    await sendPanel(ctx, buildUserCardPanel(await getUserCard(ctx, groupId, userId)));
  }
  return true;
}

function formatName(user: { name?: string; username?: string }): string | undefined {
  return user.name || user.username || undefined;
}

async function sendPanel(ctx: MyContext, panel: Panel): Promise<void> {
  await ctx.reply(panel.text, {
    reply_markup: panel.keyboard,
    parse_mode: "Markdown",
  });
}