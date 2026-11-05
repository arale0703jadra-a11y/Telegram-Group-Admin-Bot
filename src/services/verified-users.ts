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

export interface VerifiedUserAuditEvent {
  event_type: "activated" | "reactivated" | "revoked";
  created_at: string;
  activated_at: string | null;
  valid_until: string | null;
}

export interface VerifiedUsersPage {
  users: VerifiedUser[];
  totalCount: number;
  page: number;
  pageSize: number;
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
export const VERIFIED_USERS_PAGE_SIZE = 5;
export const VERIFIED_USERS_HISTORY_PAGE_SIZE = 10;
export const VERIFIED_USERS_QUERY_TIMEOUT_MS = 5_000;
const verifiedUsersPageRequests = new Map<string, Promise<VerifiedUsersPage>>();

function getVerifiedCacheExpiry(
  record: VerifiedUser | undefined,
  now: Date,
): number {
  const ttlExpiry = now.getTime() + PERMISSIONS_CACHE_TTL_MS;
  if (record?.valid_until == null) return ttlExpiry;
  return Math.min(ttlExpiry, Date.parse(record.valid_until));
}

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

export function getVerifiedUsersPage(
  groupId: number,
  page: number,
  now = new Date(),
): Promise<VerifiedUsersPage> {
  if (!Number.isSafeInteger(page) || page < 0) {
    return Promise.reject(new Error("La página de verificadas no es válida."));
  }
  return getDeduplicatedPageRequest(
    `active:${groupId}:${page}`,
    () => fetchVerifiedUsersPage(groupId, page, now),
  );
}

export function getVerifiedUsersListingPage(
  groupId: number,
  page: number,
  search?: string,
): Promise<VerifiedUsersPage> {
  if (!Number.isSafeInteger(page) || page < 0) {
    return Promise.reject(new Error("La página de verificadas no es válida."));
  }
  const normalizedSearch = search?.trim().replace(/^@/u, "");
  const key = `listing:${groupId}:${page}:${normalizedSearch ?? ""}`;
  return getDeduplicatedPageRequest(
    key,
    () => fetchVerifiedUsersListingPage(groupId, page, normalizedSearch),
  );
}

export function getRevokedVerifiedUsersPage(
  groupId: number,
  page: number,
  now = new Date(),
): Promise<VerifiedUsersPage> {
  if (!Number.isSafeInteger(page) || page < 0) {
    return Promise.reject(new Error("La página del historial no es válida."));
  }
  return getDeduplicatedPageRequest(
    `inactive:${groupId}:${page}`,
    () => fetchRevokedVerifiedUsersPage(groupId, page, now),
  );
}

function getDeduplicatedPageRequest(
  key: string,
  load: () => Promise<VerifiedUsersPage>,
): Promise<VerifiedUsersPage> {
  const existing = verifiedUsersPageRequests.get(key);
  if (existing) return existing;
  const request = load();
  verifiedUsersPageRequests.set(key, request);
  void request.finally(() => {
    if (verifiedUsersPageRequests.get(key) === request) {
      verifiedUsersPageRequests.delete(key);
    }
  }).catch(() => {});
  return request;
}

async function fetchVerifiedUsersPage(
  groupId: number,
  page: number,
  now: Date,
): Promise<VerifiedUsersPage> {
  const from = page * VERIFIED_USERS_PAGE_SIZE;
  if (!Number.isSafeInteger(from)) {
    throw new Error("La página de verificadas está fuera de rango.");
  }
  const signal = AbortSignal.timeout(VERIFIED_USERS_QUERY_TIMEOUT_MS);
  let data: unknown[] | null;
  let count: number | null;
  let queryError: unknown;
  try {
    const response = await getClient()
      .from("verified_users")
      .select("*", { count: "exact" })
      .eq("group_id", groupId)
      .eq("verified", true)
      .is("revoked_at", null)
      .or(`valid_until.is.null,valid_until.gt.${now.toISOString()}`)
      .order("display_name", { ascending: true })
      .order("user_id", { ascending: true })
      .range(from, from + VERIFIED_USERS_PAGE_SIZE - 1)
      .abortSignal(signal);
    data = response.data;
    count = response.count;
    queryError = response.error;
  } catch (error) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw error;
  }
  if (queryError) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw queryError;
  }
  if (count === null) {
    throw new Error("Supabase no devolvió el total de verificaciones activas.");
  }
  const users = ((data ?? []) as VerifiedUser[]).filter(
    (user) => isActiveVerifiedRecord(user, now),
  );
  return {
    users,
    totalCount: count,
    page,
    pageSize: VERIFIED_USERS_PAGE_SIZE,
  };
}

async function fetchVerifiedUsersListingPage(
  groupId: number,
  page: number,
  search?: string,
): Promise<VerifiedUsersPage> {
  const pageSize = 8;
  const from = page * pageSize;
  if (!Number.isSafeInteger(from)) {
    throw new Error("La página de verificadas está fuera de rango.");
  }
  const signal = AbortSignal.timeout(VERIFIED_USERS_QUERY_TIMEOUT_MS);
  let data: unknown[] | null;
  let count: number | null;
  let queryError: unknown;
  try {
    let query = getClient()
      .from("verified_users")
      .select("*", { count: "exact" })
      .eq("group_id", groupId)
      .order("display_name", { ascending: true })
      .order("user_id", { ascending: true });
    if (search) {
      const safeTerm = search.replace(/[\\%_(),"]/gu, "\\$&");
      const searchFilters = [
        `username.ilike.%${safeTerm}%`,
        `display_name.ilike.%${safeTerm}%`,
      ];
      if (/^\d+$/u.test(search)) searchFilters.push(`user_id.eq.${search}`);
      query = query.or(searchFilters.join(","));
    }
    const response = await query
      .range(from, from + pageSize - 1)
      .abortSignal(signal);
    data = response.data;
    count = response.count;
    queryError = response.error;
  } catch (error) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw error;
  }
  if (queryError) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw queryError;
  }
  if (count === null) {
    throw new Error("Supabase no devolvió el total de registros de verificadas.");
  }
  const records = (data ?? []) as VerifiedUser[];
  return {
    users: records.sort((left, right) =>
      (left.display_name || left.username || String(left.user_id)).localeCompare(
        right.display_name || right.username || String(right.user_id),
      ),
    ),
    totalCount: count,
    page,
    pageSize,
  };
}

async function fetchRevokedVerifiedUsersPage(
  groupId: number,
  page: number,
  now: Date,
): Promise<VerifiedUsersPage> {
  const pageSize = VERIFIED_USERS_HISTORY_PAGE_SIZE;
  const from = page * pageSize;
  if (!Number.isSafeInteger(from)) {
    throw new Error("La página del historial está fuera de rango.");
  }
  const signal = AbortSignal.timeout(VERIFIED_USERS_QUERY_TIMEOUT_MS);
  let data: unknown[] | null;
  let count: number | null;
  let queryError: unknown;
  try {
    const response = await getClient()
      .from("verified_users")
      .select("*", { count: "exact" })
      .eq("group_id", groupId)
      .or(
        `verified.eq.false,revoked_at.not.is.null,valid_until.lte.${now.toISOString()}`,
      )
      .order("updated_at", { ascending: false })
      .order("user_id", { ascending: true })
      .range(from, from + pageSize - 1)
      .abortSignal(signal);
    data = response.data;
    count = response.count;
    queryError = response.error;
  } catch (error) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw error;
  }
  if (queryError) {
    if (signal.aborted) {
      throw new Error("La consulta de verificadas superó el límite de tiempo.");
    }
    throw queryError;
  }
  if (count === null) {
    throw new Error("Supabase no devolvió el total del historial de verificadas.");
  }
  const users = ((data ?? []) as VerifiedUser[]).filter(
    (user) => !isActiveVerifiedRecord(user, now),
  );
  return {
    users,
    totalCount: count,
    page,
    pageSize,
  };
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
  now?: Date;
}): Promise<VerifiedUser> {
  const existing = await getStoredVerifiedUser(input.groupId, input.userId);
  const now = input.now ?? new Date();
  const dates = calculateManualVerificationDates(now);
  const existingActive = isActiveVerifiedRecord(existing, now);
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
        : dates.activatedAt,
      valid_until: existingActive
        ? existing?.valid_until ?? null
        : dates.validUntil,
      updated_at: now.toISOString(),
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
  now?: Date;
}): Promise<ManualVerificationOutcome> {
  const dates = calculateManualVerificationDates(input.now);
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
  now = new Date(),
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
  return ((data ?? []) as VerifiedUser[]).filter(
    (user) => isActiveVerifiedRecord(user, now),
  );
}

export async function getRevokedVerifiedUsers(
  groupId: number,
  now = new Date(),
): Promise<VerifiedUser[]> {
  const { data, error } = await getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as VerifiedUser[]).filter(
    (user) => !isActiveVerifiedRecord(user, now),
  );
}

export async function getVerifiedUsersForListing(
  groupId: number,
  search?: string,
): Promise<VerifiedUser[]> {
  const { data, error } = await getClient()
    .from("verified_users")
    .select("*")
    .eq("group_id", groupId)
    .order("display_name", { ascending: true });
  if (error) throw error;
  const normalizedSearch = search?.trim().toLocaleLowerCase();
  return ([...(data ?? [])] as VerifiedUser[])
    .filter((user) => {
      if (!normalizedSearch) return true;
      return [
        user.display_name,
        user.username,
        String(user.user_id),
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
    })
    .sort((left, right) =>
    (left.display_name || left.username || String(left.user_id)).localeCompare(
      right.display_name || right.username || String(right.user_id),
    ),
  );
}

export async function getVerifiedUserAuditHistory(
  groupId: number,
  userId: number,
  limit = 20,
): Promise<VerifiedUserAuditEvent[]> {
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, 100))
    : 20;
  const { data, error } = await getClient()
    .from("verified_user_manual_audit")
    .select("event_type,created_at,activated_at,valid_until")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return (data ?? []) as VerifiedUserAuditEvent[];
}

export async function getVerifiedUser(
  groupId: number,
  userId: number,
  now = new Date(),
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
  const user = (data as VerifiedUser | null) ?? undefined;
  return isActiveVerifiedRecord(user, now) ? user : undefined;
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

export async function isVerifiedUser(
  groupId: number,
  userId: number,
  now = new Date(),
): Promise<boolean> {
  const key = `${groupId}:${userId}`;
  const cached = verificationStatusCache.get(key);
  if (cached && cached.expiresAt > now.getTime()) return cached.verified;
  const record = await getVerifiedUser(groupId, userId, now);
  const verified = Boolean(record);
  verificationStatusCache.set(key, {
    expiresAt: getVerifiedCacheExpiry(record, now),
    verified,
  });
  return verified;
}

export async function getVerifiedUserPermissions(
  groupId: number,
  userId: number,
  now = new Date(),
): Promise<VerifiedUserPermissions | undefined> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return undefined;
  }
  const key = `${groupId}:${userId}`;
  const cached = permissionsCache.get(key);
  if (cached && cached.expiresAt > now.getTime()) return cached.permissions;
  try {
    const record = await getVerifiedUser(groupId, userId, now);
    const permissions = record?.permissions;
    permissionsCache.set(key, {
      expiresAt: getVerifiedCacheExpiry(record, now),
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

/**
 * Búsqueda de verificadas por grupo: ID numérico exacto, username o nombre
 * visible (coincidencia parcial, insensible a mayúsculas), o ID exacto.
 * Devuelve una página consultada en Supabase; nunca descarga todos los
 * resultados para paginar localmente.
 */
export function searchVerifiedUsers(
  groupId: number,
  term: string,
  page = 0,
): Promise<VerifiedUsersPage> {
  if (!Number.isSafeInteger(groupId) || groupId === 0) {
    return Promise.reject(new Error("El grupo de búsqueda no es válido."));
  }
  if (!Number.isSafeInteger(page) || page < 0) {
    return Promise.reject(new Error("La página de búsqueda no es válida."));
  }
  const searchTerm = term
    .trim()
    .replace(/^@/u, "")
    .replace(/[%_,().]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 64);
  if (!searchTerm || searchTerm.length > 64) {
    return Promise.reject(new Error("El término de búsqueda no es válido."));
  }
  return getVerifiedUsersListingPage(groupId, page, searchTerm);
}
