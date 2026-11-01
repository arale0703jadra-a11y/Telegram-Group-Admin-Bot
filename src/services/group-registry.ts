import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChatMember } from "@grammyjs/types";

export interface GroupCapabilities {
  canManageChat: boolean;
  canDeleteMessages: boolean;
  canManageVideoChats: boolean;
  canRestrictMembers: boolean;
  canPromoteMembers: boolean;
  canChangeInfo: boolean;
  canInviteUsers: boolean;
  canManageTags: boolean;
  canPinMessages: boolean;
  canManageTopics: boolean;
}

export interface RegisteredGroup {
  id: number;
  title: string;
  adminUserIds: number[];
  capabilities: GroupCapabilities;
}

const EMPTY_CAPABILITIES: GroupCapabilities = {
  canManageChat: false,
  canDeleteMessages: false,
  canManageVideoChats: false,
  canRestrictMembers: false,
  canPromoteMembers: false,
  canChangeInfo: false,
  canInviteUsers: false,
  canManageTags: false,
  canPinMessages: false,
  canManageTopics: false,
};

const PERMISSION_FIELDS = {
  canManageChat: "can_manage_chat",
  canDeleteMessages: "can_delete_messages",
  canManageVideoChats: "can_manage_video_chats",
  canRestrictMembers: "can_restrict_members",
  canPromoteMembers: "can_promote_members",
  canChangeInfo: "can_change_info",
  canInviteUsers: "can_invite_users",
  canManageTags: "can_manage_tags",
  canPinMessages: "can_pin_messages",
  canManageTopics: "can_manage_topics",
} as const;

export function getGroupCapabilities(member: ChatMember): GroupCapabilities {
  if (member.status !== "administrator") return { ...EMPTY_CAPABILITIES };
  return {
    canManageChat: member.can_manage_chat === true,
    canDeleteMessages: member.can_delete_messages === true,
    canManageVideoChats: member.can_manage_video_chats === true,
    canRestrictMembers: member.can_restrict_members === true,
    canPromoteMembers: member.can_promote_members === true,
    canChangeInfo: member.can_change_info === true,
    canInviteUsers: member.can_invite_users === true,
    canManageTags: member.can_manage_tags === true,
    canPinMessages: member.can_pin_messages === true,
    canManageTopics: member.can_manage_topics === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGroup(value: unknown): RegisteredGroup | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.id !== "number") {
    return undefined;
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const parsedCapabilities = { ...EMPTY_CAPABILITIES };
  for (const [key, field] of Object.entries(PERMISSION_FIELDS) as Array<
    [keyof GroupCapabilities, (typeof PERMISSION_FIELDS)[keyof typeof PERMISSION_FIELDS]]
  >) {
    const raw = capabilities[key] ?? capabilities[field];
    if (typeof raw === "boolean") parsedCapabilities[key] = raw;
  }
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : "",
    adminUserIds: Array.isArray(value.adminUserIds)
      ? value.adminUserIds.filter(
          (id): id is number => typeof id === "number" && Number.isSafeInteger(id),
        )
      : [],
    capabilities: parsedCapabilities,
  };
}

export class GroupRegistry {
  private readonly groups = new Map<number, RegisteredGroup>();
  private persistenceAvailable = true;

  constructor(private readonly file = resolve(process.cwd(), "data", "groups.json")) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.groups)) {
        throw new Error("invalid group registry structure");
      }
      for (const value of parsed.groups) {
        const group = parseGroup(value);
        if (!group) {
          throw new Error("invalid group registry entry");
        }
        this.groups.set(group.id, group);
      }
      console.log(`[REGISTRO] Cargados ${this.groups.size} grupos desde disco.`);
    } catch (error) {
      this.persistenceAvailable = false;
      console.error(
        "[REGISTRO] El archivo de grupos no se pudo cargar y se conservará sin sobrescribirlo:",
        error,
      );
    }
  }

  private save(): void {
    if (!this.persistenceAvailable) return;
    const temporaryFile = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        temporaryFile,
        JSON.stringify({ groups: [...this.groups.values()] }, null, 2),
        "utf8",
      );
      renameSync(temporaryFile, this.file);
    } catch (error) {
      console.error("[REGISTRO] No se pudo guardar el registro de grupos:", error);
      try {
        if (existsSync(temporaryFile)) rmSync(temporaryFile);
      } catch (cleanupError) {
        console.error("[REGISTRO] No se pudo limpiar el archivo temporal:", cleanupError);
      }
    }
  }

  register(chatId: number, title: string, capabilities: GroupCapabilities): void {
    const existing = this.groups.get(chatId);
    this.groups.set(chatId, {
      id: chatId,
      title,
      adminUserIds: existing?.adminUserIds ?? [],
      capabilities: { ...capabilities },
    });
    this.save();
  }

  unregister(chatId: number): void {
    if (this.groups.delete(chatId)) this.save();
  }

  markAdmin(chatId: number, userId: number): void {
    const group = this.groups.get(chatId);
    if (!group || group.adminUserIds.includes(userId)) return;
    group.adminUserIds.push(userId);
    this.save();
  }

  updateTitle(chatId: number, title: string): void {
    const group = this.groups.get(chatId);
    if (!group || group.title === title) return;
    group.title = title;
    this.save();
  }

  updateCapabilities(chatId: number, capabilities: GroupCapabilities): void {
    const group = this.groups.get(chatId);
    if (!group || Object.keys(capabilities).every(
      (key) =>
        group.capabilities[key as keyof GroupCapabilities] ===
        capabilities[key as keyof GroupCapabilities],
    )) {
      return;
    }
    group.capabilities = { ...capabilities };
    this.save();
  }

  migrate(
    oldChatId: number,
    newChatId: number,
    title: string,
    capabilities: GroupCapabilities,
  ): void {
    if (oldChatId === newChatId) {
      this.register(newChatId, title, capabilities);
      return;
    }
    const oldGroup = this.groups.get(oldChatId);
    const newGroup = this.groups.get(newChatId);
    const adminUserIds = new Set([
      ...(oldGroup?.adminUserIds ?? []),
      ...(newGroup?.adminUserIds ?? []),
    ]);
    this.groups.set(newChatId, {
      id: newChatId,
      title,
      adminUserIds: [...adminUserIds],
      capabilities: { ...capabilities },
    });
    this.groups.delete(oldChatId);
    this.save();
  }

  getAll(): Array<{ id: number; title: string; capabilities: GroupCapabilities }> {
    return [...this.groups.values()].map(({ id, title, capabilities }) => ({
      id,
      title,
      capabilities: { ...capabilities },
    }));
  }

  getUserGroups(userId: number): Array<{ id: number; title: string }> {
    return [...this.groups.values()]
      .filter((group) => group.adminUserIds.includes(userId))
      .map(({ id, title }) => ({ id, title }));
  }
}

export function reconcileBotMembership(
  target: Pick<GroupRegistry, "register" | "unregister">,
  chatId: number,
  title: string,
  member: ChatMember,
): boolean {
  if (member.status !== "administrator") {
    target.unregister(chatId);
    return false;
  }
  target.register(chatId, title, getGroupCapabilities(member));
  return true;
}

const registry = new GroupRegistry();

export function registerGroup(
  chatId: number,
  title: string,
  capabilities = EMPTY_CAPABILITIES,
): void {
  registry.register(chatId, title, capabilities);
}

export function unregisterGroup(chatId: number): void {
  registry.unregister(chatId);
}

export function markUserAsAdmin(chatId: number, userId: number): void {
  registry.markAdmin(chatId, userId);
}

export function updateRegisteredGroupTitle(chatId: number, title: string): void {
  registry.updateTitle(chatId, title);
}

export function updateRegisteredGroupCapabilities(
  chatId: number,
  capabilities: GroupCapabilities,
): void {
  registry.updateCapabilities(chatId, capabilities);
}

export function reconcileRegisteredBotMembership(
  chatId: number,
  title: string,
  member: ChatMember,
): boolean {
  return reconcileBotMembership(registry, chatId, title, member);
}

export function migrateRegisteredGroup(
  oldChatId: number,
  newChatId: number,
  title: string,
  capabilities: GroupCapabilities,
): void {
  registry.migrate(oldChatId, newChatId, title, capabilities);
}

export function getAllKnownGroups(): Array<{
  id: number;
  title: string;
  capabilities: GroupCapabilities;
}> {
  return registry.getAll();
}

export function getUserKnownGroups(
  userId: number,
): Array<{ id: number; title: string }> {
  return registry.getUserGroups(userId);
}
