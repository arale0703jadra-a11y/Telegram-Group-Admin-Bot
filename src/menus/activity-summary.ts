import { calculateActivity } from "../services/activity.js";
import type { GroupData } from "../storage/types.js";
import {
  buildActivityPanel,
  buildActivityUnavailablePanel,
  type Panel,
} from "./panels.js";

interface MenuActionLike {
  kind: string;
  section?: string;
  item?: string;
}

export function isActivityPanelAction(action: MenuActionLike): boolean {
  return action.kind === "action" && action.section === "actividad";
}

interface ActivitySummaryHandlerOptions {
  groupId: number;
  groupTitle?: string;
  authorize: () => Promise<boolean>;
  answerCallback: (message?: string) => Promise<void>;
  recordUser: () => Promise<void>;
  loadGroupData: () => Promise<GroupData>;
  presentPanel: (panel: Panel) => Promise<boolean>;
  sendError: (message: string) => Promise<void>;
  logError: (message: string, error: unknown) => void;
}

async function sendErrorSafely(
  sendError: (message: string) => Promise<void>,
  logError: (message: string, error: unknown) => void,
  message: string,
): Promise<void> {
  try {
    await sendError(message);
  } catch (error) {
    logError("No se pudo enviar el mensaje de error al administrador.", error);
  }
}

export async function handleActivitySummary(
  options: ActivitySummaryHandlerOptions,
): Promise<void> {
  let authorized: boolean;
  try {
    authorized = await options.authorize();
  } catch (error) {
    options.logError("Falló la comprobación de permisos.", error);
    authorized = false;
  }

  if (!authorized) {
    try {
      await options.answerCallback("⛔ Ya no eres administrador de ese grupo.");
    } catch (error) {
      options.logError("No se pudo responder al callback denegado.", error);
      await sendErrorSafely(
        options.sendError,
        options.logError,
        "⛔ Ya no eres administrador de ese grupo.",
      );
      return;
    }
    return;
  }

  try {
    await options.answerCallback();
  } catch (error) {
    options.logError("No se pudo confirmar el callback de actividad.", error);
  }

  try {
    await options.recordUser();
  } catch (error) {
    options.logError("No se pudo registrar al administrador observado.", error);
  }

  try {
    const data = await options.loadGroupData();
    const stats = calculateActivity(data, options.groupId);
    await options.presentPanel(buildActivityPanel(stats, options.groupTitle));
  } catch (error) {
    options.logError("No se pudo calcular o presentar el resumen.", error);
    let errorPanelPresented = false;
    try {
      errorPanelPresented = await options.presentPanel(
        buildActivityUnavailablePanel(options.groupTitle),
      );
    } catch (presentationError) {
      options.logError(
        "No se pudo presentar el estado de error del resumen.",
        presentationError,
      );
    }
    if (!errorPanelPresented) {
      await sendErrorSafely(
        options.sendError,
        options.logError,
        "⚠️ Datos de actividad no disponibles. No se pudieron leer los datos locales del grupo.",
      );
    }
  }
}

interface ActivityPanelPresentation {
  edit: (panel: Panel) => Promise<boolean>;
  reply: (panel: Panel) => Promise<void>;
  logError: (message: string, error: unknown) => void;
}

export async function presentActivityPanel(
  panel: Panel,
  presentation: ActivityPanelPresentation,
): Promise<boolean> {
  try {
    const edited = await presentation.edit(panel);
    if (edited) {
      return true;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("message is not modified")
    ) {
      return true;
    }
    presentation.logError("No se pudo editar el panel existente.", error);
  }

  try {
    await presentation.reply(panel);
    return true;
  } catch (error) {
    presentation.logError("No se pudo enviar el panel como mensaje nuevo.", error);
    return false;
  }
}
