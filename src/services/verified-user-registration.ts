import type { Api } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { IndexedUser } from "../storage/types.js";

export type VerifiedUserRegistrationErrorCode =
  | "INVALID_INPUT"
  | "USERNAME_NOT_OBSERVED"
  | "USERNAME_CHANGED"
  | "USERNAME_AMBIGUOUS"
  | "INVALID_USER_ID"
  | "USER_NOT_IN_GROUP"
  | "IDENTITY_MISMATCH"
  | "TELEGRAM_ERROR";

export class VerifiedUserRegistrationError extends Error {
  constructor(
    readonly code: VerifiedUserRegistrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerifiedUserRegistrationError";
  }
}

export async function resolveVerifiedUserInput(
  api: Pick<Api, "getChatMember">,
  groupId: number,
  input: string,
  observedUsers: IndexedUser[],
): Promise<ChatMember> {
  const text = input.trim();
  if (!text) {
    throw new VerifiedUserRegistrationError(
      "INVALID_INPUT",
      "Introduce un @username exacto ya observado en el grupo o el Telegram user ID.",
    );
  }

  let userId: number;
  let expectedUsername: string | undefined;
  if (/^\d+$/.test(text)) {
    userId = Number(text);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new VerifiedUserRegistrationError(
        "INVALID_USER_ID",
        "El Telegram user ID debe ser un número positivo válido.",
      );
    }
  } else if (text.startsWith("@")) {
    expectedUsername = text.slice(1).toLocaleLowerCase();
    if (!expectedUsername || /\s/.test(expectedUsername)) {
      throw new VerifiedUserRegistrationError(
        "INVALID_INPUT",
        "Introduce un @username exacto, sin espacios, o el Telegram user ID.",
      );
    }

    const matches = observedUsers.filter(
      (user) => user.username?.toLocaleLowerCase() === expectedUsername,
    );
    if (matches.length === 0) {
      throw new VerifiedUserRegistrationError(
        "USERNAME_NOT_OBSERVED",
        "No puedo identificar ese @username con seguridad porque ZEUS aún no lo ha observado en este grupo. Pide a la persona que escriba en el grupo y vuelve a intentarlo, o introduce su Telegram user ID.",
      );
    }
    if (matches.length > 1) {
      throw new VerifiedUserRegistrationError(
        "USERNAME_AMBIGUOUS",
        "Ese @username no identifica una única cuenta observada. Introduce el Telegram user ID.",
      );
    }
    userId = matches[0].id;
  } else {
    throw new VerifiedUserRegistrationError(
      "INVALID_INPUT",
      "Introduce un @username exacto ya observado en el grupo o el Telegram user ID; no se aceptan nombres visibles.",
    );
  }

  const member = await getVerifiedGroupMember(api, groupId, userId);
  if (
    expectedUsername &&
    member.user.username?.toLocaleLowerCase() !== expectedUsername
  ) {
    throw new VerifiedUserRegistrationError(
      "USERNAME_CHANGED",
      "El @username observado ya no coincide con el actual de esa cuenta. Introduce el username actual o su Telegram user ID.",
    );
  }
  return member;
}

export async function getVerifiedGroupMember(
  api: Pick<Api, "getChatMember">,
  groupId: number,
  userId: number,
): Promise<ChatMember> {
  let member: ChatMember;
  try {
    member = await api.getChatMember(groupId, userId);
  } catch (cause) {
    throw new VerifiedUserRegistrationError(
      "TELEGRAM_ERROR",
      "Telegram no pudo comprobar la pertenencia al grupo. Revisa los permisos del bot y la conexión, y vuelve a intentarlo.",
      { cause },
    );
  }

  if (member.user.id !== userId) {
    throw new VerifiedUserRegistrationError(
      "IDENTITY_MISMATCH",
      "Telegram devolvió una identidad distinta a la solicitada. No se guardó la verificación.",
    );
  }
  if (member.status === "left" || member.status === "kicked") {
    throw new VerifiedUserRegistrationError(
      "USER_NOT_IN_GROUP",
      "Telegram confirma que esta persona ya no pertenece al grupo.",
    );
  }
  return member;
}
