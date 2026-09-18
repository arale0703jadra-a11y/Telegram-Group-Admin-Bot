import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WarningEntry } from "../storage/types.js";

export type SecurityAction =
  | "DELETE_MESSAGE"
  | "MUTE_USER"
  | "UNMUTE_USER"
  | "BAN_USER"
  | "UNBAN_USER"
  | "KICK_USER"
  | "UPDATE_SECURITY_CONFIG"
  | "UPDATE_PROTECTED_USER"
  | "WARN_USER"
  | "UNWARN_USER"
  | "UNWARN_ALL"
  | "CLEAN_MESSAGES";

export interface SecurityCommandPayload {
  requester_id?: number;
  requester_name?: string;
  reason?: string;
  duration_minutes?: number;
  until_date?: number;
  message_ids?: number[];
  warn_limit?: number;
  warn_action?: "mute" | "ban" | "none";
  [key: string]: unknown;
}

export interface SecurityWarningRecord extends WarningEntry {
  revokedAt: string | null;
  commandId: string | null;
}

export interface SecurityCommandInput {
  groupId: number;
  action: SecurityAction;
  targetUserId?: number;
  targetMessageId?: number;
  payload?: SecurityCommandPayload;
}

export interface SecurityCommandRow {
  id: string;
  group_id: number;
  action: SecurityAction;
  target_user_id: number | null;
  target_message_id: number | null;
  payload: SecurityCommandPayload;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  created_at: string;
  executed_at: string | null;
  processing_instance_id: string | null;
  processing_token: string | null;
  lease_expires_at: string | null;
  processing_at: string | null;
  attempts: number;
  last_error: string | null;
  responsible_bot: string | null;
  cancelled_at: string | null;
}

let client: SupabaseClient | undefined;
let cerberoId: string | undefined;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para enviar órdenes a Cerbero.",
    );
  }

  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

export async function initializeCerbero(): Promise<void> {
  const db = getClient();
  const { data, error } = await db
    .from("bots")
    .select("id")
    .eq("name", "Cerbero")
    .eq("type", "security")
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    cerberoId = data.id as string;
    return;
  }

  const { data: created, error: insertError } = await db
    .from("bots")
    .insert({
      name: "Cerbero",
      type: "security",
      status: "offline",
      instance_id: process.env.CERBERO_INSTANCE_ID ?? "cerbero-primary",
      version: "1.0.0",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  if (!created?.id) throw new Error("Supabase no devolvió el ID de Cerbero.");
  cerberoId = created.id as string;
}

export async function ensureCerberoBinding(groupId: number): Promise<void> {
  const db = getClient();
  const { data: bot, error: botError } = await db
    .from("bots")
    .select("id")
    .eq("name", "Cerbero")
    .eq("type", "security")
    .maybeSingle();
  if (botError) throw botError;
  if (!bot) {
    await initializeCerbero();
  }
  const cerbero = bot ?? (cerberoId ? { id: cerberoId } : undefined);
  if (!cerbero) throw new Error("Cerbero no pudo registrarse en Supabase.");
  const { error: groupError } = await db
    .from("groups")
    .upsert({ chat_id: groupId, active: true }, { onConflict: "chat_id" });
  if (groupError) throw groupError;
  const { error: bindingError } = await db
    .from("group_bot_bindings")
    .upsert(
      { group_id: groupId, bot_id: cerbero.id, enabled: true, permissions: {} },
      { onConflict: "group_id,bot_id" },
    );
  if (bindingError) throw bindingError;
}

export async function enqueueSecurityCommand(
  input: SecurityCommandInput,
): Promise<SecurityCommandRow> {
  await ensureCerberoBinding(input.groupId);
  const payload = normalizeSecurityPayload(input.payload);
  const { data, error } = await getClient()
    .from("security_commands")
    .insert({
      group_id: input.groupId,
      action: input.action,
      target_user_id: input.targetUserId ?? null,
      target_message_id: input.targetMessageId ?? null,
      payload,
      status: "pending",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as SecurityCommandRow;
}

export function isCerberoExecutionEnabled(): boolean {
  return process.env.SECURITY_EXECUTION_MODE === "cerbero";
}

export async function delegateSecurityCommand(
  input: SecurityCommandInput,
): Promise<
  | { ok: true; queued: true; commandId: string }
  | { ok: false; error: string }
> {
  try {
    const command = await enqueueSecurityCommand(input);
    return { ok: true, queued: true, commandId: command.id };
  } catch (error) {
    console.error("[ZEUS] No se pudo enviar la orden a Cerbero:", error);
    return {
      ok: false,
      error: "No se pudo enviar la orden de seguridad a Cerbero.",
    };
  }
}

function normalizeSecurityPayload(
  payload: SecurityCommandPayload | undefined,
): SecurityCommandPayload {
  const normalized = { ...(payload ?? {}) };
  if (
    normalized.duration_minutes === undefined &&
    typeof normalized.minutes === "number"
  ) {
    normalized.duration_minutes = normalized.minutes;
  }
  if (
    normalized.until_date === undefined &&
    typeof normalized.duration_minutes === "number"
  ) {
    normalized.until_date =
      Math.floor(Date.now() / 1000) + normalized.duration_minutes * 60;
  }
  return normalized;
}

export async function getSecurityCommand(
  commandId: string,
): Promise<SecurityCommandRow | undefined> {
  const { data, error } = await getClient()
    .from("security_commands")
    .select(
      "id,group_id,action,target_user_id,target_message_id,payload,status,created_at,executed_at,processing_instance_id,processing_token,lease_expires_at,processing_at,attempts,last_error,responsible_bot,cancelled_at",
    )
    .eq("id", commandId)
    .maybeSingle();
  if (error) throw error;
  return (data as SecurityCommandRow | null) ?? undefined;
}

export async function getSecurityWarnings(
  groupId: number,
  userId: number,
): Promise<SecurityWarningRecord[]> {
  const { data, error } = await getClient()
    .from("security_warnings")
    .select("id,user_id,requester_id,requester_name,reason,created_at,revoked_at,command_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((warning) => ({
    id: warning.id,
    userId: warning.user_id,
    adminId: warning.requester_id ?? 0,
    adminName: warning.requester_name ?? "Desconocido",
    date: warning.created_at,
    reason: warning.reason,
    revokedAt: warning.revoked_at,
    commandId: warning.command_id,
  }));
}

export async function getSecurityWarningHistory(
  groupId: number,
  userId: number,
): Promise<SecurityWarningRecord[]> {
  const { data, error } = await getClient()
    .from("security_warnings")
    .select("id,user_id,requester_id,requester_name,reason,created_at,revoked_at,command_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((warning) => ({
    id: warning.id,
    userId: warning.user_id,
    adminId: warning.requester_id ?? 0,
    adminName: warning.requester_name ?? "Desconocido",
    date: warning.created_at,
    reason: warning.reason,
    revokedAt: warning.revoked_at,
    commandId: warning.command_id,
  }));
}

export interface CerberoStatus {
    status: string;
    instanceId: string;
    lastHeartbeatAt?: string;
    version?: string;
    recentErrors?: number;
    activeGroups?: number;
  }

export interface SecurityEventSummary {
    id: string;
    eventType: string;
    userId?: number;
    details: Record<string, unknown>;
    createdAt: string;
  }

  export interface SecurityStats {
    deletedMessages: number;
    mutedUsers: number;
    bannedUsers: number;
    kickedUsers: number;
    alerts: number;
    blockedLinks: number;
    spamDetected: number;
    blockedContent: number;
    lastAction?: SecurityEventSummary;
  }

  export interface SecurityUserProfile {
    userId: number;
    username?: string;
    warnings: number;
    protected: boolean;
    protectionType?: string;
    events: SecurityEventSummary[];
    admin?: boolean;
    owner?: boolean;
    verified?: boolean;
  }

  export interface SecurityGroupConfig {
    group_id: number;
    enabled: boolean;
    safe_mode: boolean;
    sanctions_enabled: boolean;
    mode: "alert" | "automatic";
    anti_spam: boolean;
    anti_flood: boolean;
    anti_links: boolean;
    anti_content: boolean;
    media_protection: boolean;
    prohibited_words: string[];
    allowed_link_domains: string[];
    warning_two_action: "delete" | "mute" | "kick" | "ban";
    warning_three_action: "kick" | "ban";
    warning_four_action: "ban";
    reincidence_enabled: boolean;
    rules: Record<string, { enabled: boolean; severity: "low" | "medium" | "high" | "critical"; action: "detect" | "delete" | "warn" | "mute" | "kick" | "ban" }>;
    sticker_limit: number;
    media_limit: number;
  }

export async function getCerberoStatus(): Promise<CerberoStatus | undefined> {
    const { data, error } = await getClient()
      .from("bots")
      .select("status, instance_id, last_heartbeat_at, version")
      .eq("name", "Cerbero")
      .order("last_heartbeat_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return {
      status: data.status,
      instanceId: data.instance_id,
      lastHeartbeatAt: data.last_heartbeat_at ?? undefined,
      version: data.version ?? undefined,
      recentErrors: await getRecentErrorCount(),
      activeGroups: await getConnectedSecurityGroupsCount(),
    };
  }

  async function getRecentErrorCount(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await getClient()
      .from("security_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", ["moderation_failed", "security_action_failed"])
      .gte("created_at", since);
    if (error) throw error;
    return count ?? 0;
  }

  async function getConnectedSecurityGroupsCount(): Promise<number> {
    const { count, error } = await getClient()
      .from("group_bot_bindings")
      .select("group_id", { count: "exact", head: true })
      .eq("enabled", true);
    if (error) throw error;
    return count ?? 0;
  }

export async function getSecurityEvents(
    groupId: number,
    limit = 10,
  ): Promise<SecurityEventSummary[]> {
    const { data, error } = await getClient()
      .from("security_events")
      .select("id,event_type,user_id,details,created_at")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((event) => ({
      id: event.id,
      eventType: event.event_type,
      userId: event.user_id ?? undefined,
      details: event.details ?? {},
      createdAt: event.created_at,
    }));
  }

export async function getConnectedSecurityGroups(): Promise<
    Array<{ chatId: number; title?: string; active: boolean }>
  > {
    const { data, error } = await getClient()
      .from("groups")
      .select("chat_id,title,active")
      .eq("active", true)
      .order("title");
    if (error) throw error;
    return (data ?? []).map((group) => ({
      chatId: group.chat_id,
      title: group.title ?? undefined,
      active: group.active,
    }));
}

export async function getSecurityConfig(groupId: number): Promise<SecurityGroupConfig> {
  const { data, error } = await getClient()
    .from("security_group_configs")
    .select("*")
    .eq("group_id", groupId)
    .maybeSingle();
  if (error) throw error;
  const config = ({
    group_id: groupId,
    enabled: true,
    safe_mode: false,
    sanctions_enabled: true,
    mode: "alert",
    anti_spam: true,
    anti_flood: true,
    anti_links: true,
    anti_content: true,
    media_protection: true,
    prohibited_words: [],
    allowed_link_domains: [],
    warning_two_action: "mute",
    warning_three_action: "kick",
    warning_four_action: "ban",
    reincidence_enabled: true,
    rules: {},
    sticker_limit: 5,
    media_limit: 8,
    ...(data ?? {}),
  }) as SecurityGroupConfig;
  return {
    ...config,
    prohibited_words: Array.isArray(config.prohibited_words) ? config.prohibited_words : [],
    allowed_link_domains: Array.isArray(config.allowed_link_domains) ? config.allowed_link_domains : [],
    rules: config.rules && typeof config.rules === "object" ? config.rules : {},
  };
}

export async function updateSecurityConfig(
  groupId: number,
  changes: Partial<Omit<SecurityGroupConfig, "group_id">>,
): Promise<void> {
  await enqueueSecurityCommand({
    groupId,
    action: "UPDATE_SECURITY_CONFIG",
    payload: changes,
  });
}

export async function updateProtectedUser(
  groupId: number,
  userId: number,
  enabled: boolean,
  username?: string,
): Promise<void> {
  await enqueueSecurityCommand({
    groupId,
    action: "UPDATE_PROTECTED_USER",
    targetUserId: userId,
    payload: { enabled, username, protectionType: "vip" },
  });
}

export async function getSecurityUserProfile(
  groupId: number,
  userId: number,
): Promise<SecurityUserProfile> {
  const { data: protectedUser, error: protectedError } = await getClient()
    .from("security_protected_users")
    .select("username,protection_type")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (protectedError) throw protectedError;
  const events = await getSecurityEventsForUser(groupId, userId);
  const latestUsername = events.find((event) => event.details.username)?.details.username;
  return {
    userId,
    username: protectedUser?.username ?? (typeof latestUsername === "string" ? latestUsername : undefined),
    warnings: events.filter((event) => event.eventType === "security_violation").length,
    protected: Boolean(protectedUser),
    protectionType: protectedUser?.protection_type ?? undefined,
    events,
  };
}

async function getSecurityEventsForUser(groupId: number, userId: number): Promise<SecurityEventSummary[]> {
  const { data, error } = await getClient()
    .from("security_events")
    .select("id,event_type,user_id,details,created_at")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    userId: event.user_id ?? undefined,
    details: event.details ?? {},
    createdAt: event.created_at,
  }));
}

export async function clearSecurityWarnings(groupId: number, userId: number): Promise<void> {
  const { error } = await getClient()
    .from("security_events")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("event_type", "security_violation");
  if (error) throw error;
}

export async function enqueueManualSecurityAction(
  groupId: number,
  userId: number,
  action: "MUTE_USER" | "BAN_USER" | "KICK_USER" | "DELETE_MESSAGE",
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (action === "DELETE_MESSAGE" && !payload.messageId) {
    const events = await getSecurityEventsForUser(groupId, userId);
    const messageIds = events
      .map((event) => event.details.messageId)
      .filter((id): id is number => typeof id === "number")
      .slice(0, 20);
    for (const messageId of messageIds) {
      await enqueueSecurityCommand({
        groupId,
        targetUserId: userId,
        targetMessageId: messageId,
        action,
        payload,
      });
    }
    return;
  }
  await enqueueSecurityCommand({ groupId, targetUserId: userId, action, payload });
}

export async function getSecurityStats(groupId: number): Promise<SecurityStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events = await getSecurityEventsSince(groupId, since);
  const stats: SecurityStats = {
    deletedMessages: 0, mutedUsers: 0, bannedUsers: 0, kickedUsers: 0,
    alerts: 0, blockedLinks: 0, spamDetected: 0, blockedContent: 0,
    lastAction: events[0],
  };
  for (const event of events) {
    const details = event.details;
    const action = typeof details.actionPerformed === "string" ? details.actionPerformed : "";
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes("delete")) stats.deletedMessages++;
    if (normalizedAction.includes("mute")) stats.mutedUsers++;
    if (normalizedAction.includes("ban_user") || normalizedAction === "ban") stats.bannedUsers++;
    if (normalizedAction.includes("kick")) stats.kickedUsers++;
    if (event.eventType === "security_violation") stats.alerts++;
    if (details.violationType === "excessive_links") stats.blockedLinks++;
    if (typeof details.violationType === "string" && ["flood", "spam_repeated", "repeat_offender"].includes(details.violationType)) {
      stats.spamDetected++;
    }
    if (event.eventType === "prohibited_content_detected") stats.blockedContent++;
  }
  return stats;
}

async function getSecurityEventsSince(groupId: number, since: string): Promise<SecurityEventSummary[]> {
  const { data, error } = await getClient()
    .from("security_events")
    .select("id,event_type,user_id,details,created_at")
    .eq("group_id", groupId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    userId: event.user_id ?? undefined,
    details: event.details ?? {},
    createdAt: event.created_at,
  }));
}
