import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";

export type GroupRegistrationErrorCode =
  | "TELEGRAM_ERROR"
  | "ZEUS_NOT_ADMIN"
  | "MISSING_REQUIRED_PERMISSIONS";

export class GroupRegistrationError extends Error {
  constructor(
    readonly code: GroupRegistrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GroupRegistrationError";
  }
}

export async function verifyZeusCanAdministerGroup(
  api: Pick<Api, "getChatMember">,
  groupId: number,
  botId: number,
): Promise<ChatMember> {
  let member: ChatMember;
  try {
    member = await api.getChatMember(groupId, botId);
  } catch (cause) {
    throw new GroupRegistrationError(
      "TELEGRAM_ERROR",
      "Telegram no pudo comprobar los permisos de ZEUS en el grupo. Vuelve a intentarlo.",
      { cause },
    );
  }

  if (member.status !== "administrator") {
    throw new GroupRegistrationError(
      "ZEUS_NOT_ADMIN",
      "Para registrar este grupo, ZEUS debe ser administrador. No se registro el grupo.",
    );
  }

  if (!member.can_delete_messages || !member.can_restrict_members) {
    throw new GroupRegistrationError(
      "MISSING_REQUIRED_PERMISSIONS",
      "ZEUS necesita los permisos de borrar mensajes y restringir miembros antes de registrar este grupo.",
    );
  }

  return member;
}
