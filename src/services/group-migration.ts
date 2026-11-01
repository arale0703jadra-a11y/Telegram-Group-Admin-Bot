import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import {
  getGroupCapabilities,
  migrateRegisteredGroup,
  unregisterGroup,
  type GroupCapabilities,
} from "./group-registry.js";
import { moveGroupStorage } from "../storage/index.js";

export interface GroupMigrationApi {
  getChatMember(chatId: number | string, userId: number): Promise<ChatMember>;
  getChat(chatId: number | string): ReturnType<Api["getChat"]>;
}

export interface GroupMigrationResult {
  registered: boolean;
  storageMoved: boolean;
}

export interface GroupMigrationMessage {
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export function getMigratedGroupIds(
  currentChatId: number,
  message: GroupMigrationMessage,
): { oldChatId: number; newChatId: number } | undefined {
  if (message.migrate_to_chat_id !== undefined) {
    return {
      oldChatId: currentChatId,
      newChatId: message.migrate_to_chat_id,
    };
  }
  if (message.migrate_from_chat_id !== undefined) {
    return {
      oldChatId: message.migrate_from_chat_id,
      newChatId: currentChatId,
    };
  }
  return undefined;
}

export interface GroupMigrationDependencies {
  migrateRegisteredGroup(
    oldChatId: number,
    newChatId: number,
    title: string,
    capabilities: GroupCapabilities,
  ): void;
  unregisterGroup(chatId: number): void;
  moveGroupStorage(fromChatId: number, toChatId: number): Promise<boolean>;
}

const defaultDependencies: GroupMigrationDependencies = {
  migrateRegisteredGroup,
  unregisterGroup,
  moveGroupStorage,
};

export async function processGroupMigration(
  api: GroupMigrationApi,
  oldChatId: number,
  newChatId: number,
  botId: number,
  fallbackTitle: string,
  dependencies: GroupMigrationDependencies = defaultDependencies,
): Promise<GroupMigrationResult> {
  let botMember: ChatMember;
  try {
    botMember = await api.getChatMember(newChatId, botId);
  } catch (error) {
    console.error(
      `[GROUP_REGISTRY] No se pudo verificar el grupo migrado oldChatId=${oldChatId} newChatId=${newChatId}:`,
      error,
    );
    dependencies.unregisterGroup(oldChatId);
    return { registered: false, storageMoved: false };
  }

  if (botMember.status !== "administrator") {
    dependencies.unregisterGroup(oldChatId);
    return { registered: false, storageMoved: false };
  }

  let title = fallbackTitle;
  try {
    const newChat = await api.getChat(newChatId);
    if ("title" in newChat && typeof newChat.title === "string") {
      title = newChat.title;
    }
  } catch (error) {
    console.warn(
      `[GROUP_REGISTRY] No se pudo actualizar el título del grupo migrado newChatId=${newChatId}:`,
      error,
    );
  }

  let storageMoved = false;
  try {
    storageMoved = await dependencies.moveGroupStorage(oldChatId, newChatId);
    if (!storageMoved) {
      console.warn(
        `[GROUP_REGISTRY] No se movió el almacenamiento; se conserva el estado existente oldChatId=${oldChatId} newChatId=${newChatId}.`,
      );
    }
  } catch (error) {
    console.error(
      `[GROUP_REGISTRY] No se pudo mover el almacenamiento oldChatId=${oldChatId} newChatId=${newChatId}:`,
      error,
    );
  }

  dependencies.migrateRegisteredGroup(
    oldChatId,
    newChatId,
    title,
    getGroupCapabilities(botMember),
  );
  return { registered: true, storageMoved };
}
