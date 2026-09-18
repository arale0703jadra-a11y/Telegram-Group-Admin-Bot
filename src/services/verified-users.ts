import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
  custom_title_detected?: string | null;
  title_lost_at?: string | null;
}

export const DEFAULT_VERIFIED_PERMISSIONS: VerifiedUserPermissions = {
  can_post: true,
  can_send_media: true,
  can_send_links: true,
  bypass_antispam: true,
  bypass_promotion_filter: true,
  bypass_illegal_filter: false,
  bypass_automatic_deletion: false,
};

let client: SupabaseClient | undefined;

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

export async function addVerifiedUser(input: {
  groupId: number;
  userId: number;
  username?: string;
  displayName?: string;
  createdBy: number;
  permissions?: Partial<VerifiedUserPermissions>;
  verificationMethod?: "manual" | "detected_custom_title";
  detectedAt?: string;
  customTitleDetected?: string;
}): Promise<VerifiedUser> {
  const existing = await getStoredVerifiedUser(input.groupId, input.userId);
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
      updated_at: new Date().toISOString(),
      verification_method: input.verificationMethod ?? "manual",
      detected_at: input.detectedAt ?? null,
      custom_title_detected: input.customTitleDetected ?? null,
      title_lost_at: null,
  };
  const query = existing
    ? getClient().from("verified_users").update(values)
      .eq("group_id", input.groupId).eq("user_id", input.userId)
    : getClient().from("verified_users").insert(values);
  const { data, error } = await query.select("*").single();
  if (error) throw error;
  return data as VerifiedUser;
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
  return data as VerifiedUser;
}

export async function revokeVerifiedUser(groupId: number, userId: number): Promise<void> {
  const { error } = await getClient()
    .from("verified_users")
    .update({
      verified: false,
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw error;
}

export async function markVerifiedTitleLoss(
  groupId: number,
  userId: number,
  lostAt: string,
): Promise<void> {
  const { error } = await getClient()
    .from("verified_users")
    .update({ title_lost_at: lostAt, updated_at: new Date().toISOString() })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("verified", true)
    .is("revoked_at", null);
  if (error) throw error;
}

export async function clearVerifiedTitleLoss(
  groupId: number,
  userId: number,
): Promise<void> {
  const { error } = await getClient()
    .from("verified_users")
    .update({ title_lost_at: null, updated_at: new Date().toISOString() })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("verified", true)
    .is("revoked_at", null);
  if (error) throw error;
}

export async function isVerifiedUser(groupId: number, userId: number): Promise<boolean> {
  return Boolean(await getVerifiedUser(groupId, userId));
}

export async function getVerifiedUserPermissions(
  groupId: number,
  userId: number,
): Promise<VerifiedUserPermissions | undefined> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return undefined;
  }
  try {
    return (await getVerifiedUser(groupId, userId))?.permissions;
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
