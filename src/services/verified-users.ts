import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { isActiveVerifiedRecord } from "./verified-user-policy.js";
import { unmarkUserVerified } from "./user-registry.js";
import { flushStorage } from "../storage/index.js";

export interface VerifiedUserPermissions {
  can_post: boolean;
  can_send_media: boolean;
  can_send_links: boolean;
  bypass_antispam: boolean;
  bypass_promotion_filter: boolean;
  bypass_illegal_filter: boolean;
  bypass_automatic_deletion: boolean;
}

export interface VerifiedUser {
  id: string;
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
  verified: boolean;
  permissions: VerifiedUserPermissions;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  revoked_at: string | null;
  verification_method?: "manual" | "detected_custom_title";
  detected_at?: string | null;
  activated_at?: string | null;
  valid_until?: string | null;
}

export const MANUAL_VERIFICATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

export interface ManualVerificationDates {
  activatedAt: string;
  validUntil: string;
}

export interface ExpiredVerifiedUserSummary {
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
  valid_until: string | null;
}

export interface AutoRevocationNotification {
  event_key: string;
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
}

export type ManualVerificationOutcome =
  | { status: "created" | "reactivated"; user: VerifiedUser }
  | { status: "already_active" | "reactivation_required" | "not_found" };

export function calculateManualVerificationDates(
  now = new Date(),
): ManualVerificationDates {
  const activatedAt = new Date(now.getTime());
  return {
    activatedAt: activatedAt.toISOString(),
    validUntil: new Date(
      activatedAt.getTime() + MANUAL_VERIFICATION_VALIDITY_MS,
    ).toISOString(),
  };
}

export const DEFAULT_VERIFIED_PERMISSIONS: VerifiedUserPermissions = {
  can_post: true,
  can_send_media: true,
  can_send_links: true,
  bypass_antispam: false,
  bypass_promotion_filter: false,
  bypass_illegal_filter: false,
  bypass_automatic_deletion: false,
};

let client: SupabaseClient | undefined;
const permissionsCache = new Map<
  string,
  {
    expiresAt: number;
    permissions: VerifiedUserPermissions | undefined;
  }
>();
const verificationStatusCache = new Map<
  string,
  { expiresAt: number; verified: boolean }
>();
const PERMISSIONS_CACHE_TTL_MS = 10_000;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan credenciales de Supabase para verificadas.");
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

export function normalizeVerifiedPermissions(
  permissions?: Partial<VerifiedUserPermissions>,
): VerifiedUserPermissions {
  return { ...DEFAULT_VERIFIED_PERMISSIONS, ...(permissions ?? {}) };
}

export function invalidateVerifiedUserCache(groupId: number, userId: number): void {
  const key = `${groupId}:${userId}`;
  permissionsCache.delete(key);
  verificationStatusCache.delete(key);
}

export async function addVerifiedUser(input: {
  groupId: number;
  userId: number;
  username?: string;
  displayName?: string;
  createdBy: number;
  verificationMethod?: "manual" | "detected_custom_title";
  detectedAt?: string;
  reactivate?: boolean;
  permissions?: Partial<VerifiedUserPermissions>;
}): Promise<VerifiedUser> {
  const existing = await getStoredVerifiedUser(input.groupId, input.userId);
  const now = calculateManualVerificationDates();
  const existingActive = isActiveVerifiedRecord(existing);
  if (existing && !existingActive && !input.reactivate) {
    throw new Error("VERIFIED_REACTIVATION_REQUIRED");
  }
  const values = {
      group_id: input.groupId,
      user_id: input.userId,
      username: input.username ?? null,
      display_name: input.displayName ?? null,
      verified: true,
      permissions: normalizeVerifiedPermissions(
        input.permissions ?? existing?.permissions,
      ),
      created_by: input.createdBy,
      revoked_at: null,
      ...(input.verificationMethod
        ? { verification_method: input.verificationMethod }
        : {}),
      ...(input.detectedAt ? { detected_at: input.detectedAt } : {}),
      activated_at: existingActive
        ? existing?.activated_at ?? null
        : now.activatedAt,
      valid_until: existingActive
        ? existing?.valid_until ?? null
        : now.validUntil,
      updated_at: new Date().toISOString(),
  };
  const query = existing
    ? getClient().from("verified_users").update(values)
      .eq("group_id", input.groupId).eq("user_id", input.userId)
    : getClient().from("verified_users").insert(values);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  invalidateVerifiedUserCache(input.groupId, input.userId);
  return data as VerifiedUser;
}

export async function activateManualVerifiedUser(input: {
  groupId: number;
  userId: number;
  username?: string;
  displayName?: string;
  actorUserId: number;
  reactivate: boolean;
}): Promise<ManualVerificationOutcome> {
  const dates = calculateManualVerificationDates();
  const { data, error } = await getClient().rpc(
    "activate_manual_verified_user",
    {
      p_group_id: input.groupId,
      p_user_id: input.userId,
      p_actor_user_id: input.actorUserId,
      p_username: input.username ?? null,
      p_display_name: input.displayName ?? null,
      p_permissions: DEFAULT_VERIFIED_PERMISSIONS,
      p_reactivate: input.reactivate,
      p_event_key: randomUUID(),
      p_activated_at: dates.activatedAt,
      p_valid_until: dates.validUntil,
    },
  );
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Respuesta no válida al activar la verificación manual.");
  }

  const result = data as Record<string, unknown>;
  if (
    result.status === "created" ||
    result.status === "reactivated"
  ) {
    if (!result.user || typeof result.user !== "object" || Array.isArray(result.user)) {
      throw new Error("La activación no devolvió el registro guardado.");
    }
    invalidateVerifiedUserCache(input.groupId, input.userId);
    return {
      status: result.status,
      user: result.user as VerifiedUser,
    };
  }
  if (
    result.status === "already_active" ||
    result.status === "reactivation_required" ||
    result.status === "not_found"
  ) {
    return { status: result.status };
  }
  throw new Error("Estado no reconocido al activar la verificación manual.");
}

export async function revokeManualVerifiedUser(input: {
  groupId: number;
  userId: number;
  actorUserId: number;
}): Promise<boolean> {
  const { data, error } = await getClient().rpc(
    "revoke_manual_verified_user",
    {
      p_group_id: input.groupId,
      p_user_id: input.userId,
      p_actor_user_id: input.actorUserId,
      p_event_key: randomUUID(),
    },
  );
  if (error) throw error;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("status" in data)
  ) {
    throw new Error("Respuesta no válida al revocar la verificación.");
  }
  const result = data as Record<string, unknown>;
  if (result.status !== "revoked" && result.status !== "not_active") {
    throw new Error("Estado no reconocido al revocar la verificación.");
  }
  if (result.status === "revoked") {
    invalidateVerifiedUserCache(input.groupId, input.userId);
    return true;
  }
  return false;
}

async function getStoredVerifiedUser(
  groupId: number,
  userId: number,
): Promise<VerifiedUser | undefined> {
  const { data, error } = await getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as VerifiedUser | null) ?? undefined;
}

export async function getVerifiedUserRecord(
  groupId: number,
  userId: number,
): Promise<VerifiedUser | undefined> {
  return getStoredVerifiedUser(groupId, userId);
}

export async function getVerifiedUsers(
  groupId: number,
  search?: string,
): Promise<VerifiedUser[]> {
  let query = getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .eq("verified", true)
    .is("revoked_at", null)
    .order("display_name", { ascending: true });
  if (search?.trim()) {
    const term = search.trim().replace(/^@/, "");
    query = query.or(`username.ilike.%${term}%,display_name.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as VerifiedUser[];
}

export async function getRevokedVerifiedUsers(
  groupId: number,
): Promise<VerifiedUser[]> {
  const { data, error } = await getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as VerifiedUser[]).filter(
    (user) => !user.verified || user.revoked_at !== null,
  );
}

export async function getVerifiedUser(
  groupId: number,
  userId: number,
): Promise<VerifiedUser | undefined> {
  const { data, error } = await getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("verified", true)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as VerifiedUser | null) ?? undefined;
}

export async function updateVerifiedUser(
  groupId: number,
  userId: number,
  changes: {
    username?: string;
    displayName?: string;
    permissions?: Partial<VerifiedUserPermissions>;
  },
): Promise<VerifiedUser> {
  const current = await getVerifiedUser(groupId, userId);
  if (!current) throw new Error("VERIFIED_USER_NOT_FOUND");
  const { data, error } = await getClient()
    .from("verified_users")
    .update({
      username: changes.username ?? current.username,
      display_name: changes.displayName ?? current.display_name,
      permissions: changes.permissions
        ? normalizeVerifiedPermissions({ ...current.permissions, ...changes.permissions })
        : current.permissions,
      updated_at: new Date().toISOString(),
    })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throw error;
  invalidateVerifiedUserCache(groupId, userId);
  return data as VerifiedUser;
}

export async function revokeVerifiedUser(groupId: number, userId: number): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await getClient()
    .from("verified_users")
    .update({
      verified: false,
      revoked_at: now,
      updated_at: now,
    })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (data && typeof data === "object") {
    invalidateVerifiedUserCache(groupId, userId);
    return true;
  }
  return false;
}

export async function revokeExpiredVerifiedUser(
  groupId: number,
  userId: number,
  now = new Date(),
): Promise<AutoRevocationNotification | undefined> {
  const eventKey = randomUUID();
  const { data, error } = await getClient().rpc(
    "revoke_expired_verified_user",
    {
      p_group_id: groupId,
      p_user_id: userId,
      p_now: now.toISOString(),
      p_event_key: eventKey,
    },
  );
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Respuesta no válida al revocar una verificación vencida.");
  }
  const result = data as Record<string, unknown>;
  if (result.status === "not_expired" || result.status === "not_active") {
    return undefined;
  }
  if (
    result.status !== "revoked" ||
    typeof result.event_key !== "string" ||
    typeof result.group_id !== "number" ||
    typeof result.user_id !== "number"
  ) {
    throw new Error("Estado no reconocido al revocar una verificación vencida.");
  }
  invalidateVerifiedUserCache(groupId, userId);
  return {
    event_key: result.event_key,
    group_id: result.group_id,
    user_id: result.user_id,
    username: typeof result.username === "string" ? result.username : null,
    display_name: typeof result.display_name === "string" ? result.display_name : null,
  };
}

export async function listPendingAutoRevocationNotifications(
  groupId: number,
): Promise<AutoRevocationNotification[]> {
  const { data, error } = await getClient()
    .from("verified_user_auto_revocation_outbox")
    .select("event_key, group_id, user_id, username, display_name")
    .eq("group_id", groupId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AutoRevocationNotification[];
}

export async function claimAutoRevocationNotification(
  eventKey: string,
): Promise<AutoRevocationNotification | undefined> {
  const { data, error } = await getClient().rpc(
    "claim_verified_auto_revocation_notification",
    { p_event_key: eventKey },
  );
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Respuesta no válida al reclamar el anuncio de revocación.");
  }
  const result = data as Record<string, unknown>;
  if (result.status === "not_pending") return undefined;
  if (
    result.status !== "claimed" ||
    typeof result.event_key !== "string" ||
    typeof result.group_id !== "number" ||
    typeof result.user_id !== "number"
  ) {
    throw new Error("Estado no reconocido al reclamar el anuncio de revocación.");
  }
  return {
    event_key: result.event_key,
    group_id: result.group_id,
    user_id: result.user_id,
    username: typeof result.username === "string" ? result.username : null,
    display_name: typeof result.display_name === "string" ? result.display_name : null,
  };
}

export async function finishAutoRevocationNotification(
  eventKey: string,
  outcome: "sent" | "unknown",
): Promise<void> {
  const { data, error } = await getClient().rpc(
    "finish_verified_auto_revocation_notification",
    { p_event_key: eventKey, p_outcome: outcome },
  );
  if (error) throw error;
  if (data !== true) {
    throw new Error("No se pudo cerrar el estado del anuncio de revocación.");
  }
}

export async function deliverPendingAutoRevocationNotifications(
  groupId: number,
  api: Pick<import("grammy").Api, "sendMessage">,
): Promise<number> {
  const pending = await listPendingAutoRevocationNotifications(groupId);
  let announced = 0;
  for (const notification of pending) {
    const claimed = await claimAutoRevocationNotification(notification.event_key);
    if (!claimed) continue;
    const label = claimed.username
      ? `@${claimed.username}`
      : claimed.display_name || `ID ${claimed.user_id}`;
    try {
      await api.sendMessage(
        groupId,
        `⚠️ ${label} ya no está verificada: su vigencia de 30 días ha finalizado.`,
      );
      await finishAutoRevocationNotification(claimed.event_key, "sent");
      announced += 1;
    } catch (error) {
      try {
        await finishAutoRevocationNotification(claimed.event_key, "unknown");
      } catch (stateError) {
        console.error(
          `[VERIFIED_AUTO_REVOCATION] No se pudo registrar estado desconocido del anuncio groupId=${groupId} userId=${claimed.user_id}:`,
          stateError,
        );
      }
      console.error(
        `[VERIFIED_AUTO_REVOCATION] Revocación confirmada; anuncio de resultado incierto groupId=${groupId} userId=${claimed.user_id}:`,
        error,
      );
    }
  }
  return announced;
}

export async function listExpiredVerifiedUsers(
  groupId: number,
  now = new Date(),
): Promise<ExpiredVerifiedUserSummary[]> {
  const cutoff = now.toISOString();
  const { data, error } = await getClient()
    .from("verified_users")
    .select("group_id, user_id, username, display_name, valid_until")
    .eq("group_id", groupId)
    .eq("verified", true)
    .is("revoked_at", null)
    .not("valid_until", "is", null)
    .lte("valid_until", cutoff)
    .order("valid_until", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ExpiredVerifiedUserSummary[];
}

export async function processAutoRevocationForGroup(
  groupId: number,
  enabled: boolean,
  api: Pick<import("grammy").Api, "sendMessage">,
  now = new Date(),
  dependencies: Partial<AutoRevocationDependencies> = {},
): Promise<{ revoked: number; announced: number; errors: number }> {
  const operations: AutoRevocationDependencies = {
    listExpired: listExpiredVerifiedUsers,
    revokeExpired: revokeExpiredVerifiedUser,
    listPending: listPendingAutoRevocationNotifications,
    unmarkLocal: unmarkUserVerified,
    flushLocal: flushStorage,
    deliverPending: deliverPendingAutoRevocationNotifications,
    ...dependencies,
  };
  let revoked = 0;
  let errors = 0;
  const confirmedRevocations = new Map<number, AutoRevocationNotification>();

  if (enabled) {
    let expired: ExpiredVerifiedUserSummary[] = [];
    try {
      expired = await operations.listExpired(groupId, now);
    } catch (error) {
      errors += 1;
      logAutoRevocationFailure(groupId, undefined, "expiry_lookup", error);
    }

    for (const user of expired) {
      try {
        const notification = await operations.revokeExpired(groupId, user.user_id, now);
        if (notification) {
          revoked += 1;
          confirmedRevocations.set(notification.user_id, notification);
        }
      } catch (error) {
        errors += 1;
        logAutoRevocationFailure(groupId, user.user_id, "persist_revocation", error);
      }
    }
  }

  let pending: AutoRevocationNotification[];
  try {
    pending = await operations.listPending(groupId);
  } catch (error) {
    errors += 1;
    logAutoRevocationFailure(groupId, undefined, "outbox_lookup", error);
    return { revoked, announced: 0, errors };
  }

  const usersToUnmark = new Map(
    [...confirmedRevocations.values(), ...pending].map((notification) => [
      notification.user_id,
      notification,
    ]),
  );
  if (usersToUnmark.size > 0) {
    let localSyncFailed = false;
    for (const notification of usersToUnmark.values()) {
      try {
        await operations.unmarkLocal(groupId, notification.user_id);
      } catch (error) {
        localSyncFailed = true;
        errors += 1;
        logAutoRevocationFailure(
          groupId,
          notification.user_id,
          "local_unmark",
          error,
        );
      }
    }
    try {
      await operations.flushLocal();
    } catch (error) {
      localSyncFailed = true;
      errors += 1;
      logAutoRevocationFailure(groupId, undefined, "local_sync", error);
    }
    if (localSyncFailed) {
      return { revoked, announced: 0, errors };
    }
  }

  let announced = 0;
  try {
    announced = await operations.deliverPending(groupId, api);
  } catch (error) {
    errors += 1;
    logAutoRevocationFailure(groupId, undefined, "announcement", error);
  }
  return {
    revoked,
    announced,
    errors,
  };
}

export interface AutoRevocationDependencies {
  listExpired: typeof listExpiredVerifiedUsers;
  revokeExpired: typeof revokeExpiredVerifiedUser;
  listPending: typeof listPendingAutoRevocationNotifications;
  unmarkLocal: typeof unmarkUserVerified;
  flushLocal: typeof flushStorage;
  deliverPending: typeof deliverPendingAutoRevocationNotifications;
}

function logAutoRevocationFailure(
  groupId: number,
  userId: number | undefined,
  stage: string,
  error: unknown,
): void {
  const rawName = error instanceof Error ? error.name : "NonError";
  const errorClass = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(rawName)
    ? rawName
    : "Error";
  console.error(
    `[VERIFIED_AUTO_REVOCATION] stage=${stage} groupId=${groupId}` +
      `${userId === undefined ? "" : ` userId=${userId}`} errorClass=${errorClass}`,
  );
}

export async function isVerifiedUser(groupId: number, userId: number): Promise<boolean> {
  const key = `${groupId}:${userId}`;
  const cached = verificationStatusCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.verified;
  const record = await getVerifiedUser(groupId, userId);
  const verified = isActiveVerifiedRecord(record);
  verificationStatusCache.set(key, {
    expiresAt: Date.now() + PERMISSIONS_CACHE_TTL_MS,
    verified,
  });
  return verified;
}

export async function getVerifiedUserPermissions(
  groupId: number,
  userId: number,
): Promise<VerifiedUserPermissions | undefined> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return undefined;
  }
  const key = `${groupId}:${userId}`;
  const cached = permissionsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.permissions;
  try {
    const record = await getVerifiedUser(groupId, userId);
    const permissions = record?.permissions;
    permissionsCache.set(key, {
      expiresAt: Date.now() + PERMISSIONS_CACHE_TTL_MS,
      permissions,
    });
    return permissions;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "42P01" || code === "PGRST205") {
      console.warn("[ZEUS] verified_users todavía no está disponible; se conserva el comportamiento actual.");
      return undefined;
    }
    throw error;
  }
}
