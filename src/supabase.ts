import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Centralized Supabase client factory for ZEUS.
 *
 * Architecture rule (least privilege):
 * - INTERNAL: uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Reserved for
 *   operations that require administrative access (user sessions, verified
 *   users, recovery keys, security command enqueueing, system owner). Never
 *   exposed to browser/client code or public interfaces.
 * - RESTRICTED: uses `SUPABASE_RESTRICTED_URL` + `SUPABASE_RESTRICTED_KEY` if
 *   configured. Intended for delegated operations that do not need full
 *   administrative access. Returns undefined if not configured; callers must
 *   handle that case gracefully.
 *
 * Single instance: repeated calls return the same client. Do not create
 * additional clients per module.
 */

let internalClient: SupabaseClient | undefined;
let internalClientFingerprint: string | undefined;
let restrictedClient: SupabaseClient | undefined;
let restrictedClientFingerprint: string | undefined;

function fingerprint(url: string, key: string): string {
  return `${url}\u0000${key}`;
}

/**
 * Drops every cached client. Tests and diagnostics use it after changing the
 * environment so a stale client can never answer for a configuration that is
 * no longer present.
 *
 * Desde la auditoría Fase 7 ningún servicio guarda su propio cliente: todos
 * resuelven `getInternalSupabaseClient()` en cada llamada, de modo que este
 * reinicio (y el fingerprint de URL+clave) alcanza también a
 * `security-commands`, `system-owner`, `verified-users`,
 * `verified-tag-reviews`, `user-session-storage` y `afrodita-bridge`.
 */
export function resetSupabaseClients(): void {
  internalClient = undefined;
  internalClientFingerprint = undefined;
  restrictedClient = undefined;
  restrictedClientFingerprint = undefined;
}

export interface SupabaseClientOptions {
  /** Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (administrative). */
  internal?: boolean;
  /** Uses SUPABASE_RESTRICTED_URL + SUPABASE_RESTRICTED_KEY when configured. */
  restricted?: boolean;
}

export function getSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL;
}

export function getSupabaseServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export function getRestrictedSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_RESTRICTED_URL;
}

export function getRestrictedSupabaseKey(): string | undefined {
  return process.env.SUPABASE_RESTRICTED_KEY;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseServiceRoleKey());
}

/**
 * Returns the internal administrative client (service_role).
 * Throws a descriptive error if Supabase is not configured.
 */
export function getInternalSupabaseClient(): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) {
    // Never serve a cached client for a configuration that no longer exists.
    internalClient = undefined;
    internalClientFingerprint = undefined;
    throw new Error(
      "SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY no están configuradas. " +
        "Esta operación requiere acceso administrativo a Supabase.",
    );
  }
  const current = fingerprint(url, key);
  if (internalClient && internalClientFingerprint === current) {
    return internalClient;
  }
  internalClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  internalClientFingerprint = current;
  return internalClient;
}

/**
 * Returns the restricted client when configured. Useful for operations that do
 * not require full administrative access. Undefined means the restricted role
 * has not been configured.
 */
export function getRestrictedSupabaseClient(): SupabaseClient | undefined {
  const url = getRestrictedSupabaseUrl();
  const key = getRestrictedSupabaseKey();
  if (!url || !key) {
    restrictedClient = undefined;
    restrictedClientFingerprint = undefined;
    return undefined;
  }
  const current = fingerprint(url, key);
  if (restrictedClient && restrictedClientFingerprint === current) {
    return restrictedClient;
  }
  restrictedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  restrictedClientFingerprint = current;
  return restrictedClient;
}
