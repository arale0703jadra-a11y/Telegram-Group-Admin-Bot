import assert from "node:assert/strict";
import test from "node:test";
import {
  addVerifiedUser,
  DEFAULT_VERIFIED_PERMISSIONS,
  isVerifiedUser,
  normalizeVerifiedPermissions,
  revokeVerifiedUser,
} from "../src/services/verified-users.js";
import {
  buildUserStatusBadges,
  canRevokeVerifiedAdministrator,
  isActiveVerifiedRecord,
  shouldSkipPromotionFilter,
} from "../src/services/verified-user-policy.js";

type MockVerifiedRow = {
  id: string;
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
  verified: boolean;
  permissions: typeof DEFAULT_VERIFIED_PERMISSIONS;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  revoked_at: string | null;
};

const mockRows: MockVerifiedRow[] = [];
const realFetch = globalThis.fetch;
process.env.SUPABASE_URL = "https://verified-users.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const matches = (row: MockVerifiedRow): boolean =>
    [...url.searchParams.entries()].every(([key, expression]) => {
      if (key === "select" || key === "order") return true;
      const [operator, value] = expression.split(".", 2);
      if (operator === "eq") return String(row[key as keyof MockVerifiedRow]) === value;
      if (operator === "is" && value === "null") return row[key as keyof MockVerifiedRow] == null;
      return true;
    });
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const response = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (!url.pathname.endsWith("/rest/v1/verified_users")) {
    return response({ message: "Unexpected mock route" }, 404);
  }
  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request && input.body
        ? await input.clone().text()
        : "";
  if (method === "GET") {
    return response(mockRows.filter(matches));
  }
  if (method === "POST") {
    const values = JSON.parse(bodyText) as Omit<MockVerifiedRow, "id" | "created_at" | "updated_at">;
    const now = new Date().toISOString();
    const row: MockVerifiedRow = {
      ...values,
      id: `mock-${mockRows.length + 1}`,
      created_at: now,
      updated_at: now,
    };
    mockRows.push(row);
    return response(headers.get("accept")?.includes("vnd.pgrst.object")
      ? row
      : [row]);
  }
  if (method === "PATCH") {
    const values = JSON.parse(bodyText) as Partial<MockVerifiedRow>;
    const changed = mockRows.filter(matches);
    for (const row of changed) Object.assign(row, values);
    return response(headers.get("accept")?.includes("vnd.pgrst.object")
      ? changed[0]
      : changed);
  }
  return response({ message: "Unsupported mock method" }, 405);
};

test("verified permissions have the requested safe defaults", () => {
  assert.deepEqual(DEFAULT_VERIFIED_PERMISSIONS, {
    can_post: true,
    can_send_media: true,
    can_send_links: true,
    bypass_antispam: true,
    bypass_promotion_filter: true,
    bypass_illegal_filter: false,
    bypass_automatic_deletion: false,
  });
});

test("existing spam and illegal-content bypass defaults remain unchanged", () => {
  assert.equal(DEFAULT_VERIFIED_PERMISSIONS.bypass_antispam, true);
  assert.equal(DEFAULT_VERIFIED_PERMISSIONS.bypass_illegal_filter, false);
  assert.equal(DEFAULT_VERIFIED_PERMISSIONS.bypass_automatic_deletion, false);
});

test("permission edits preserve unspecified values", () => {
  const permissions = normalizeVerifiedPermissions({ bypass_illegal_filter: true });
  assert.equal(permissions.bypass_illegal_filter, true);
  assert.equal(permissions.bypass_antispam, true);
  assert.equal(permissions.can_post, true);
});

test("new and previously registered active users are recognized without title metadata", () => {
  const activeRecord = { verified: true, revoked_at: null };
  assert.equal(isActiveVerifiedRecord(activeRecord), true);
  assert.equal(isActiveVerifiedRecord(activeRecord), true);
  assert.equal(isActiveVerifiedRecord(undefined), false);
});

test("revoked records are not treated as verified and may be reactivated without duplicating the record", () => {
  assert.equal(isActiveVerifiedRecord({ verified: false, revoked_at: "2026-01-01" }), false);
  assert.equal(isActiveVerifiedRecord({ verified: true, revoked_at: "2026-01-01" }), false);
});

test("an active verification stays independent of a member's Telegram administrator status", () => {
  const verified = { verified: true, revoked_at: null };
  assert.equal(isActiveVerifiedRecord(verified), true);
  assert.deepEqual(buildUserStatusBadges("member", true), [
    "👤 Usuario",
    "✅ Verificada",
  ]);
});

test("verified administrators display both Telegram and ZEUS states", () => {
  assert.deepEqual(buildUserStatusBadges("administrator", true), [
    "🛡️ Administradora",
    "✅ Verificada",
  ]);
});

test("Telegram creator is protected from permission revocation", () => {
  assert.equal(
    canRevokeVerifiedAdministrator({
      status: "creator",
      isBot: false,
      isVerified: true,
      isProtected: false,
      botCanPromote: true,
    }),
    false,
  );
});

test("bots, protected users, and non-verified admins cannot be demoted by the verified action", () => {
  const base = {
    status: "administrator" as const,
    isBot: false,
    isVerified: true,
    isProtected: false,
    botCanPromote: true,
  };
  assert.equal(canRevokeVerifiedAdministrator({ ...base, isBot: true }), false);
  assert.equal(canRevokeVerifiedAdministrator({ ...base, isProtected: true }), false);
  assert.equal(canRevokeVerifiedAdministrator({ ...base, isVerified: false }), false);
});

test("only a verified non-protected administrator can be demoted when ZEUS can promote", () => {
  const input = {
    status: "administrator" as const,
    isBot: false,
    isVerified: true,
    isProtected: false,
    botCanPromote: true,
  };
  assert.equal(canRevokeVerifiedAdministrator(input), true);
  assert.equal(canRevokeVerifiedAdministrator({ ...input, botCanPromote: false }), false);
  assert.equal(isActiveVerifiedRecord({ verified: true, revoked_at: null }), true);
});

test("the promotion verification source accepts only an active verified_users record", () => {
  assert.equal(isActiveVerifiedRecord({ verified: true, revoked_at: null }), true);
  assert.equal(isActiveVerifiedRecord({ verified: false, revoked_at: null }), false);
  assert.equal(isActiveVerifiedRecord({ verified: true, revoked_at: "revoked" }), false);
});

test("a Telegram custom title alone never creates an active ZEUS verification", () => {
  const titleOnlyRecord = {
    verified: false,
    revoked_at: null,
    custom_title_detected: "Verificada",
  };
  assert.equal(isActiveVerifiedRecord(titleOnlyRecord), false);
});

test("promotion filter bypass depends on verified-user permissions, not local user caches", () => {
  assert.equal(shouldSkipPromotionFilter(true, false), false);
  assert.equal(shouldSkipPromotionFilter(true, true), true);
  assert.equal(shouldSkipPromotionFilter(false, false), true);
});

test("manual add persists a current group member using only columns present before migrations 009/010", async () => {
  mockRows.length = 0;
  const user = await addVerifiedUser({
    groupId: -10001,
    userId: 501,
    username: "new_verified",
    displayName: "New Verified",
    createdBy: 700,
  });
  assert.equal(user.verified, true);
  assert.equal(await isVerifiedUser(-10001, 501), true);
  assert.equal(mockRows.length, 1);
  assert.deepEqual(
    Object.keys(mockRows[0]).sort(),
    [
      "created_at",
      "created_by",
      "display_name",
      "group_id",
      "id",
      "permissions",
      "revoked_at",
      "updated_at",
      "user_id",
      "username",
      "verified",
    ].sort(),
  );
});

test("adding an already active user reuses the verified_users row instead of duplicating it", async () => {
  const existing = mockRows[0];
  const updated = await addVerifiedUser({
    groupId: existing.group_id,
    userId: existing.user_id,
    username: existing.username ?? undefined,
    displayName: existing.display_name ?? undefined,
    createdBy: 701,
  });
  assert.equal(updated.id, existing.id);
  assert.equal(mockRows.length, 1);
  assert.equal(await isVerifiedUser(existing.group_id, existing.user_id), true);
});

test("reactivating a revoked verification restores the existing row and preserves its permissions", async () => {
  const existing = mockRows[0];
  await revokeVerifiedUser(existing.group_id, existing.user_id);
  assert.equal(await isVerifiedUser(existing.group_id, existing.user_id), false);
  const reactivated = await addVerifiedUser({
    groupId: existing.group_id,
    userId: existing.user_id,
    createdBy: 702,
  });
  assert.equal(reactivated.id, existing.id);
  assert.equal(reactivated.verified, true);
  assert.equal(reactivated.permissions.can_post, true);
  assert.equal(mockRows.length, 1);
  assert.equal(await isVerifiedUser(existing.group_id, existing.user_id), true);
});
