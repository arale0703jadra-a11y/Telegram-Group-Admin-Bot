import type { MyContext } from "../types.js";
import { getAdministrableGroups } from "./groups.js";
import { buildGroupPickerPanel, buildMainPanel } from "../menus/panels.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";

const UNAUTHORIZED_MESSAGE =
  "⛔ No autorizado para acceder al panel de ZEUS.\n\n" +
  "El panel global solo está disponible para las identidades autorizadas por configuración o registradas como System Owner. Ser administrador de un grupo no concede por sí solo acceso al panel.\n\n" +
  "La recuperación no autoriza cuentas nuevas ni cambia los permisos de grupo. Si esta cuenta ya está autorizada, escribe /zeus-recuperar sin argumentos y luego envía la clave en otro mensaje privado.\n\n" +
  "Nunca escribas la clave en grupos ni la compartas.";

const NO_GROUPS_MESSAGE =
  "⛔ No tienes ningún grupo administrable con este bot.\n\n" +
  "Para empezar:\n" +
  "1️⃣ Añádeme a tu grupo y promuévelo a administrador.\n" +
  "2️⃣ En el grupo, escribe /menu para activar el acceso.\n" +
  "3️⃣ Vuelve aquí y pulsa /menu.";

/**
 * Abre el panel de administración en el chat privado del bot:
 *
 * - Sin grupos administrables: mensaje de acceso denegado.
 * - Un solo grupo: abre directamente el panel de ese grupo.
 * - Varios grupos: muestra el selector de grupos.
 */
export async function openPrivatePanel(ctx: MyContext): Promise<void> {
  if (!ctx.from || !(await isAuthorizedPanelUser(ctx.from.id))) {
    await ctx.reply(UNAUTHORIZED_MESSAGE);
    return;
  }

  const groups = await getAdministrableGroups(ctx);

  if (groups.length === 0) {
    await ctx.reply(NO_GROUPS_MESSAGE);
    return;
  }

  if (groups.length === 1) {
    const group = groups[0];
    ctx.session.user = {
      selectedGroupId: group.id,
      selectedGroupTitle: group.title,
    };
    const panel = buildMainPanel(group.title);
    await ctx.reply(panel.text, {
      reply_markup: panel.keyboard,
      parse_mode: "Markdown",
    });
    return;
  }

  const picker = buildGroupPickerPanel(groups);
  await ctx.reply(picker.text, {
    reply_markup: picker.keyboard,
    parse_mode: "Markdown",
  });
}