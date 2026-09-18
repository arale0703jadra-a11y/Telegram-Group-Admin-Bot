import { Composer } from "grammy";
import { isUserAdminOf } from "../utils/permissions.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import { normalizeFilterTerm } from "../filters/detector.js";
import {
  getTrackedUser,
  getUserCard,
  resolveUserTrigger,
  searchObservedUsers,
} from "../utils/users.js";
import {
  buildBanConfirmPanel,
  buildFiltersPanel,
  buildIllegalPanel,
  buildMuteMenuPanel,
  buildUserCardPanel,
  buildUserSearchResultsPanel,
  buildWarningsPanel,
  buildSubmenuPanel,
  type Panel,
} from "../menus/panels.js";
import { renderPanel } from "../menus/render.js";
import { muteUser, unmuteUser, warnUser } from "../moderation/actions.js";
import {
  delegateSecurityCommand,
  isCerberoExecutionEnabled,
} from "../services/security-commands.js";
import type { MyContext, PickAction } from "../types.js";
import { addVerifiedUser } from "../services/verified-users.js";
import { markUserVerified, recordObservedUser } from "../services/user-registry.js";
import { automaticMessageScheduler } from "../services/automatic-messages.js";
import {
  consumeRecoveryKey,
} from "../services/system-owner.js";

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
  if (
    ctx.session.user.pendingSince &&
    Date.now() - ctx.session.user.pendingSince > 10 * 60 * 1000
  ) {
    ctx.session.user.pendingAction = undefined;
    ctx.session.user.pendingSince = undefined;
    await ctx.reply("⌛ Esta operación expiró. Vuelve a pulsar el botón para intentarlo de nuevo.");
    return;
  }
  if (pending.kind === "recoveryKey") {
    ctx.session.user.pendingAction = undefined;
    ctx.session.user.pendingSince = undefined;
    const telegramUserId = ctx.from.id;
    const telegramChatId = ctx.chat.id;
    try {
      const recovered = await consumeRecoveryKey(
        text,
        telegramUserId,
        async () =>
          ctx.chat?.type === "private" &&
          ctx.chat.id === telegramChatId &&
          ctx.from?.id === telegramUserId &&
          await (async () => {
            try {
              const chat = await ctx.api.getChat(telegramUserId);
              return chat.id === telegramUserId && chat.type === "private";
            } catch {
              return false;
            }
          })(),
      );
      await ctx.reply(
        recovered
          ? "✅ Propiedad de ZEUS recuperada. Esta clave ya no puede volver a usarse."
          : "⛔ Clave de recuperación inválida, revocada o ya utilizada.",
      );
    } catch {
      await ctx.reply("⛔ No se pudo procesar la recuperación.");
    }
    return;
  }
  if (
    pending.kind === "automaticMessage" ||
    pending.kind === "automaticFrequency" ||
    pending.kind === "configMentions" ||
    pending.kind === "verifiedTitles"
  ) {
    if (!(await isUserAdminOf(ctx, pending.groupId))) {
      ctx.session.user.pendingAction = undefined;
      await ctx.reply("⛔ Ya no eres administrador de ese grupo.");
      return;
    }
    const data = await getGroupData(pending.groupId);
    if (pending.kind === "automaticMessage") {
      data.automaticMessage = {
        enabled: data.automaticMessage?.enabled ?? false,
        message: text,
        intervalMinutes: data.automaticMessage?.intervalMinutes ?? 60,
      };
      await saveGroupData(pending.groupId, data);
      await automaticMessageScheduler.refreshGroup(pending.groupId);
      await ctx.reply("✅ Mensaje automático guardado.");
    } else if (pending.kind === "automaticFrequency") {
      const minutes = Number(text);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) {
        await ctx.reply("❌ La frecuencia debe ser un número entero entre 1 y 43200.");
        return;
      }
      if (!data.automaticMessage) {
        await ctx.reply("❌ Primero crea un mensaje automático.");
        return;
      }
      data.automaticMessage.intervalMinutes = minutes;
      data.automaticMessage.nextRunAt = data.automaticMessage.enabled
        ? new Date(Date.now() + minutes * 60_000).toISOString()
        : undefined;
      await saveGroupData(pending.groupId, data);
      await automaticMessageScheduler.refreshGroup(pending.groupId);
      await ctx.reply("✅ Frecuencia guardada.");
    } else if (pending.kind === "verifiedTitles") {
      const titles = [...new Set(text.split(",").map((title) => title.trim()).filter(Boolean))];
      if (titles.length === 0) {
        await ctx.reply("❌ Debes indicar al menos un título.");
        return;
      }
      data.verifiedTitles = titles;
      await saveGroupData(pending.groupId, data);
      await ctx.reply("✅ Títulos reconocidos guardados.");
    } else {
      const mentions = Number(text);
      if (!Number.isInteger(mentions) || mentions < 0 || mentions > 50) {
        await ctx.reply("❌ Escribe un número entero entre 0 y 50.");
        return;
      }
      data.antiSpam.maxMentionsPerMessage = mentions;
      await saveGroupData(pending.groupId, data);
      await ctx.reply("✅ Límite de menciones guardado.");
    }
    ctx.session.user.pendingAction = undefined;
    const section = pending.kind === "automaticMessage" || pending.kind === "automaticFrequency"
        ? "mensajes"
        : "config";
    const panel = buildSubmenuPanel(section, ctx.session.user.selectedGroupTitle);
    if (panel) await renderPanel(ctx, panel);
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
    if (pending.kind === "verifiedAdd") {
      ctx.session.user.pendingAction = undefined;
      ctx.session.user.pendingSince = undefined;
      try {
        let resolved = await resolveUserTrigger(ctx, pending.groupId, text);
        if (!resolved && /^-?\d+$/.test(text)) {
          const userId = Number(text);
          if (Number.isSafeInteger(userId) && userId > 0) {
            await recordObservedUser(pending.groupId, { id: userId });
            resolved = { id: userId };
          }
        }
        if (!resolved) {
          await ctx.reply(
            "❌ No encontré ese usuario. Usa un @username ya observado o introduce su telegram_id numérico.",
          );
          return;
        }
        await addVerifiedUser({
          groupId: pending.groupId,
          userId: resolved.id,
          username: resolved.username,
          displayName: resolved.name,
          createdBy: ctx.from.id,
          verificationMethod: "manual",
        });
        await markUserVerified(
          pending.groupId,
          resolved.id,
          resolved.username,
          resolved.name,
        );
        console.log(`[VERIFIED] Usuario verificado agregado groupId=${pending.groupId} userId=${resolved.id}`);
        await ctx.reply(`✅ Usuario añadido correctamente: ${resolved.username ? `@${resolved.username}` : resolved.name || resolved.id}`);
      } catch (error) {
        console.error("[VERIFIED] No se pudo agregar el usuario:", error);
        await ctx.reply("⛔ No se pudo guardar la verificación.");
      }
      return;
    }
    if (pending.kind === "illegalAdd") {
      const term = text.replace(/\s+/g, " ").trim();
      const normalized = normalizeFilterTerm(term);
      const data = await getGroupData(pending.groupId);
      if (!normalized) {
        await ctx.reply("❌ Escribe un término válido.");
        return;
      }
      if (data.illegalContent.customTerms.some((item) => normalizeFilterTerm(item) === normalized)) {
        await ctx.reply("ℹ️ Esa palabra personalizada ya existe.");
        return;
      }
      data.illegalContent.customTerms.push(term);
      await saveGroupData(pending.groupId, data);
      ctx.session.user.pendingAction = undefined;
      await ctx.reply("✅ Palabra personalizada agregada.");
      await sendPanel(ctx, buildIllegalPanel(data.illegalContent, ctx.session.user.selectedGroupTitle));
      return;
    }
    if (pending.kind === "filterAdd") {
      const term = text.replace(/\s+/g, " ").trim();
      const normalized = normalizeFilterTerm(term);
      if (!normalized) {
        await ctx.reply("❌ Escribe una palabra o frase válida.");
        return;
      }
      const data = await getGroupData(pending.groupId);
      const exists = data.promotion.dictionary.some(
        (item) => normalizeFilterTerm(item) === normalized,
      );
      if (exists) {
        await ctx.reply(`ℹ️ El filtro "${term}" ya existe.`);
        return;
      }
      data.promotion.dictionary.push(term);
      await saveGroupData(pending.groupId, data);
      ctx.session.user.pendingAction = undefined;
      await ctx.reply(
        `✅ Filtro agregado\n\n"${term}"\n\nLa palabra ya forma parte de los filtros de este grupo.`,
      );
      await sendPanel(
        ctx,
        buildFiltersPanel(data.promotion, ctx.session.user.selectedGroupTitle),
      );
      return;
    }
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
  if (isCerberoExecutionEnabled()) {
    const queued = await delegateSecurityCommand({
      groupId,
      action: "WARN_USER",
      targetUserId: userId,
      payload: {
        requester_id: ctx.from?.id,
        requester_name: ctx.from?.first_name,
        reason: reason.trim(),
        warn_limit: data.warnLimit,
        warn_action: data.warnAction,
      },
    });
    await ctx.reply(
      queued.ok
        ? `⏳ Advertencia enviada a Cerbero (${queued.commandId}).`
        : `⛔ ${queued.error}`,
    );
    return;
  }
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
      if (isCerberoExecutionEnabled()) {
        const queued = await delegateSecurityCommand({
          groupId,
          action: "UNMUTE_USER",
          targetUserId: user.id,
        });
        await ctx.reply(
          queued.ok ? "⏳ Desmute enviado a Cerbero." : `⛔ ${queued.error}`,
        );
        return true;
      }
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

  if (isCerberoExecutionEnabled()) {
    const queued = await delegateSecurityCommand({
      groupId,
      action: "MUTE_USER",
      targetUserId: userId,
      payload: {
        duration_minutes: minutes,
        reason: "Acción manual desde Zeus",
      },
    });
    await ctx.reply(
      queued.ok
        ? `⏳ Silencio de ${minutes} min enviado a Cerbero.`
        : `⛔ ${queued.error}`,
    );
    return true;
  }

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