import { Composer } from "grammy";
import { COMMAND_NAMES } from "./definitions.js";
import type { MyContext } from "../types.js";

export function getZeusCommandName(
  message: NonNullable<MyContext["message"]>,
  botUsername: string,
): string | undefined {
  const commandEntity = message.entities?.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!commandEntity) return undefined;
  const token = (message.text ?? "").slice(0, commandEntity.length);
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/u.exec(token);
  if (!match) return undefined;
  const addressedUsername = match[2];
  if (
    addressedUsername &&
    addressedUsername.toLocaleLowerCase() !== botUsername.toLocaleLowerCase()
  ) {
    return undefined;
  }
  const command = match[1]?.toLocaleLowerCase();
  return command && COMMAND_NAMES.has(command) ? command : undefined;
}

export const deleteGroupCommand = new Composer<MyContext>();

function logDeleteFailure(
  error: unknown,
  groupId: number,
  messageId: number,
): void {
  const code =
    typeof error === "object" && error !== null && "error_code" in error
      ? String(error.error_code)
      : undefined;
  console.warn(
    `[COMMAND_DELETE] No se pudo borrar el comando groupId=${groupId} ` +
      `messageId=${messageId} error=${error instanceof Error ? error.name : "unknown"}` +
      `${code ? ` code=${code}` : ""}`,
  );
}

deleteGroupCommand.on("message:entities", async (ctx, next) => {
  if (
    (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") &&
    ctx.message &&
    getZeusCommandName(ctx.message, ctx.me.username)
  ) {
    try {
      void ctx.api
        .deleteMessage(ctx.chat.id, ctx.message.message_id)
        .catch((error: unknown) =>
          logDeleteFailure(error, ctx.chat!.id, ctx.message!.message_id),
        );
    } catch (error) {
      logDeleteFailure(error, ctx.chat.id, ctx.message.message_id);
    }
  }
  await next();
});
