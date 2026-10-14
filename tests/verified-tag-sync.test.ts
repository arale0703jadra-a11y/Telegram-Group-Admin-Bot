import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import { FileStore } from "../src/storage/file.js";
import {
  buildVerifiedTagCandidatesPanel,
  buildVerifiedTagReviewConfirmPanel,
  buildVerifiedTitleConfigPanel,
} from "../src/menus/panels.js";
import {
  DEFAULT_VERIFIED_PERMISSIONS,
  type VerifiedUser,
} from "../src/services/verified-users.js";
import {
  claimVerifiedTagReview,
  decideVerifiedTagReview,
  getVerifiedTagReview,
  listVerifiedTagReviews,
  recordVerifiedTagObservation,
  recoverExpiredVerifiedTagReviewClaim,
  withVerifiedTagReviewLock,
} from "../src/services/verified-tag-reviews.js";
import { observeVerifiedMemberTag } from "../src/services/verified-tag-sync.js";
import {
  approveVerifiedTagCandidate,
  VerifiedTagApprovalError,
} from "../src/services/verified-tag-approval.js";
import { initialGroupData } from "../src/storage/initial.js";

const verifiedRows: VerifiedUser[] = [];
const reviewRows: Array<Record<string, unknown>> = [];
const auditRows = new Map<string, Record<string, unknown>>();
const realFetch = globalThis.fetch;
process.env.SUPABASE_URL = "https://verified-tag.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

function matches(row: Record<string, unknown>, url: URL): boolean {
  for (const [key, expression] of url.searchParams.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "on_conflict") {
      continue;
    }
    const separator = expression.indexOf(".");
    const operator = expression.slice(0, separator);
    const value = expression.slice(separator + 1);
    if (operator === "eq" && String(row[key]) !== value) return false;
    if (operator === "is" && value === "null" && row[key] != null) return false;
    if (operator === "in") {
      const allowed = value.slice(1, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
      if (!allowed.includes(String(row[key]))) return false;
    }
  }
  return true;
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request && input.body
        ? await input.clone().text()
        : "";
  const response = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const objectResponse = headers.get("accept")?.includes("vnd.pgrst.object") ?? false;
  const route = url.pathname.split("/").pop();

  if (route === "verified_users") {
    if (method === "GET") {
      return response(verifiedRows.filter((row) => matches(row as unknown as Record<string, unknown>, url)));
    }
    if (method === "POST") {
      const body = JSON.parse(bodyText) as Partial<VerifiedUser>;
      const existingIndex = verifiedRows.findIndex(
        (row) => row.group_id === body.group_id && row.user_id === body.user_id,
      );
      const row = {
        ...(existingIndex >= 0 ? verifiedRows[existingIndex] : {}),
        ...body,
        id: existingIndex >= 0
          ? verifiedRows[existingIndex]?.id
          : `verified-${verifiedRows.length + 1}`,
        created_at: existingIndex >= 0
          ? verifiedRows[existingIndex]?.created_at
          : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as VerifiedUser;
      if (existingIndex >= 0) verifiedRows[existingIndex] = row;
      else verifiedRows.push(row);
      return response(objectResponse ? row : [row]);
    }
    if (method === "PATCH") {
      const changed = verifiedRows.filter(
        (row) => matches(row as unknown as Record<string, unknown>, url),
      );
      const body = JSON.parse(bodyText) as Partial<VerifiedUser>;
      for (const row of changed) Object.assign(row, body);
      return response(objectResponse ? changed[0] ?? null : changed);
    }
  }

  if (route === "verified_member_tag_reviews") {
    if (method === "GET") {
      return response(reviewRows.filter((row) => matches(row, url)));
    }
    if (method === "POST") {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      const existingIndex = reviewRows.findIndex(
        (row) => row.group_id === body.group_id && row.user_id === body.user_id,
      );
      const row = {
        ...(existingIndex >= 0 ? reviewRows[existingIndex] : {}),
        ...body,
      };
      if (existingIndex >= 0) reviewRows[existingIndex] = row;
      else reviewRows.push(row);
      return response(objectResponse ? row : [row]);
    }
    if (method === "PATCH") {
      const changed = reviewRows.filter((row) => matches(row, url));
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      for (const row of changed) Object.assign(row, body);
      return response(objectResponse ? changed[0] ?? null : changed);
    }
  }

  if (route === "verified_member_tag_audit" && method === "POST") {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const key = String(body.event_key);
    if (!auditRows.has(key)) auditRows.set(key, body);
    return response([]);
  }
  return response({ message: `Unexpected mock route ${route}` }, 404);
};

test.after(() => {
  globalThis.fetch = realFetch;
});

test.beforeEach(() => {
  verifiedRows.length = 0;
  reviewRows.length = 0;
  auditRows.clear();
});

function makeMember(
  status: "member" | "restricted" | "administrator" = "member",
  tag?: string,
): ChatMember {
  if (status === "administrator") {
    return {
      status,
      user: {
        id: 501,
        is_bot: false,
        first_name: "Test",
        username: "test_user",
      },
      custom_title: "Verificada",
    } as ChatMember;
  }
  return {
    status,
    user: {
      id: 501,
      is_bot: false,
      first_name: "Test",
      username: "test_user",
    },
    ...(tag ? { tag } : {}),
  } as ChatMember;
}

function verifiedRecord(
  groupId: number,
  userId: number,
  revoked = false,
): VerifiedUser {
  return {
    id: `verified-${groupId}-${userId}`,
    group_id: groupId,
    user_id: userId,
    username: "test_user",
    display_name: "Test",
    verified: !revoked,
    permissions: { ...DEFAULT_VERIFIED_PERMISSIONS },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    created_by: 100,
    revoked_at: revoked ? new Date(1).toISOString() : null,
  };
}

function mockMemberApi(
  result: ChatMember | Error,
  onCall?: () => void,
): Pick<Api, "getChatMember"> {
  return {
    getChatMember: async () => {
      onCall?.();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("tag synchronization is disabled by default for new groups", () => {
  const data = initialGroupData();
  assert.equal(data.verifiedTagSyncEnabled, false);
  assert.deepEqual(data.verifiedMemberTags, ["Verificada"]);
});

test("legacy group files remain readable and do not enable tag synchronization", async () => {
  const originalDirectory = process.cwd();
  const testDirectory = mkdtempSync(join(tmpdir(), "zeus-tag-sync-"));
  try {
    process.chdir(testDirectory);
    mkdirSync(join(testDirectory, "data", "storage"), { recursive: true });
    writeFileSync(
      join(testDirectory, "data", "storage", "-100.json"),
      JSON.stringify({
        verifiedTitles: ["Modelo antigua"],
        autoDetectVerifiedTitles: true,
        autoRemoveVerifiedWhenTitleRemoved: true,
      }),
    );
    const data = await new FileStore().loadGroup(-100);

    assert.deepEqual(data.verifiedTitles, ["Modelo antigua"]);
    assert.equal(data.autoDetectVerifiedTitles, true);
    assert.equal(data.verifiedTagSyncEnabled, false);
    assert.deepEqual(data.verifiedMemberTags, ["Verificada"]);
  } finally {
    process.chdir(originalDirectory);
    rmSync(resolve(testDirectory), { recursive: true, force: true });
  }
});

test("review panels expose an empty state and only actionable review statuses", () => {
  const empty = buildVerifiedTagCandidatesPanel([], 0, "Grupo");
  assert.match(empty.text, /No hay candidatas ni discrepancias/);
  assert.equal(
    empty.keyboard.inline_keyboard.flat().some((button) =>
      button.callback_data?.startsWith("vu:review:"),
    ),
    false,
  );

  const review = {
    group_id: -100,
    user_id: 501,
    username: "test_user",
    display_name: "Test",
    observed_tag: "Verificada",
    status: "revoked_tag" as const,
    first_seen_at: new Date(0).toISOString(),
    last_seen_at: new Date(0).toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    review_claim_token: null,
    review_claim_expires_at: null,
    review_claim_previous_status: null,
  };
  const panel = buildVerifiedTagCandidatesPanel([review], 0, "Grupo");
  assert.ok(panel.keyboard.inline_keyboard.flat().some((button) =>
    button.text.startsWith("♻️ Aprobar reactivación"),
  ));
  assert.equal(
    panel.keyboard.inline_keyboard.flat().some((button) =>
      button.text.startsWith("❌ Rechazar"),
    ),
    false,
  );
  assert.match(
    buildVerifiedTagReviewConfirmPanel(review, "approve", "Grupo").text,
    /reactivará mediante la aprobación manual/,
  );
});

test("the group panel clearly marks tag detection as opt-in", () => {
  const panel = buildVerifiedTitleConfigPanel(
    ["legacy"],
    true,
    true,
    "Grupo",
    ["Verificada"],
    false,
    0,
  );
  assert.match(panel.text, /Detección por etiquetas: desactivada/);
  assert.match(panel.text, /no concede ni revoca permisos/);
  assert.ok(panel.keyboard.inline_keyboard.flat().some((button) =>
    button.callback_data === "cfg:verified_tags_toggle",
  ));
});

test("a recognized tag creates one review candidate and never a verified record", async () => {
  const first = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "VERIFICADA"),
    recognizedTags: ["Verificada"],
  });
  const repeated = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(first.classification, "pending");
  assert.equal(repeated.classification, "pending");
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0]?.status, "pending");
  assert.equal(verifiedRows.length, 0);
  assert.equal(auditRows.size, 1);
});

test("custom_title on an administrator is not treated as a member tag", async () => {
  const result = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("administrator"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(result.classification, "ignored");
  assert.equal(reviewRows.length, 0);
});

test("a recognized tag on an active verified user records a match without changing authority", async () => {
  verifiedRows.push(verifiedRecord(-100, 501));
  const result = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(result.classification, "matched");
  assert.equal(verifiedRows[0]?.verified, true);
  assert.equal(reviewRows[0]?.status, "matched");
});

test("a confirmed missing recognized tag is informational and does not revoke verification", async () => {
  verifiedRows.push(verifiedRecord(-100, 501));
  const result = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(result.classification, "missing_tag");
  assert.equal(verifiedRows[0]?.verified, true);
  assert.equal(reviewRows[0]?.status, "missing_tag");
});

test("a revoked record with a matching tag is a discrepancy and is not reactivated", async () => {
  verifiedRows.push(verifiedRecord(-100, 501, true));
  const result = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(result.classification, "revoked_tag");
  assert.equal(verifiedRows[0]?.verified, false);
  assert.equal(reviewRows[0]?.status, "revoked_tag");
});

test("review rows are isolated by group even for the same Telegram user", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });
  await observeVerifiedMemberTag({
    groupId: -200,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  assert.equal((await listVerifiedTagReviews(-100)).length, 1);
  assert.equal((await listVerifiedTagReviews(-200)).length, 1);
  assert.equal(reviewRows.length, 2);
});

test("a rejected candidate is not reopened by repeated tag updates", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });
  const rejected = await decideVerifiedTagReview({
    groupId: -100,
    userId: 501,
    decision: "rejected",
    actorUserId: 100,
  });
  const repeated = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(rejected?.status, "rejected");
  assert.equal(repeated.classification, "ignored");
  assert.equal((await getVerifiedTagReview(-100, 501))?.status, "rejected");
});

test("only one concurrent review action can consume a pending candidate", async () => {
  await recordVerifiedTagObservation({
    groupId: -100,
    userId: 501,
    observedTag: "Verificada",
    status: "pending",
  });
  const decisions = await Promise.all(
    ["approved", "rejected"].map((decision) =>
      withVerifiedTagReviewLock(-100, 501, () =>
        decideVerifiedTagReview({
          groupId: -100,
          userId: 501,
          decision: decision as "approved" | "rejected",
          actorUserId: 100,
        }),
      ),
    ),
  );

  assert.equal(decisions.filter(Boolean).length, 1);
  assert.ok(["approved", "rejected"].includes(String(reviewRows[0]?.status)));
});

test("database claim allows only one concurrent approval across workers", async () => {
  await recordVerifiedTagObservation({
    groupId: -100,
    userId: 501,
    observedTag: "Verificada",
    status: "pending",
  });
  const claims = await Promise.all([
    claimVerifiedTagReview({
      groupId: -100,
      userId: 501,
      expectedStatus: "pending",
      actorUserId: 100,
    }),
    claimVerifiedTagReview({
      groupId: -100,
      userId: 501,
      expectedStatus: "pending",
      actorUserId: 200,
    }),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await getVerifiedTagReview(-100, 501))?.status, "approving");
});

test("an expired approval claim can be recovered after a process restart", async () => {
  await recordVerifiedTagObservation({
    groupId: -100,
    userId: 501,
    observedTag: "Verificada",
    status: "pending",
  });
  const claim = await claimVerifiedTagReview({
    groupId: -100,
    userId: 501,
    expectedStatus: "pending",
    actorUserId: 100,
  });
  assert.ok(claim?.review_claim_token);
  const row = reviewRows[0];
  assert.ok(row);
  row.status = "approving";
  row.review_claim_token = claim.review_claim_token;
  row.review_claim_previous_status = "pending";
  row.review_claim_expires_at = new Date(0).toISOString();

  const recovered = await recoverExpiredVerifiedTagReviewClaim(-100, 501);
  assert.equal(recovered?.status, "pending");
  assert.equal(recovered?.review_claim_token, null);
  assert.equal(recovered?.review_claim_expires_at, null);
});

test("unknown tags do not create candidates", async () => {
  const result = await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Modelo"),
    recognizedTags: ["Verificada"],
  });

  assert.equal(result.classification, "ignored");
  assert.equal(reviewRows.length, 0);
});

test("manual approval revalidates and uses the internal verified-user service", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });
  const result = await approveVerifiedTagCandidate({
    api: mockMemberApi(makeMember("member", "Verificada")),
    groupId: -100,
    userId: 501,
    actorUserId: 100,
    recognizedTags: ["Verificada"],
    authorize: async () => true,
    syncLocal: async () => undefined,
  });

  assert.equal(result.status, "approved");
  assert.equal(verifiedRows.length, 1);
  assert.equal(verifiedRows[0]?.verified, true);
  assert.equal(verifiedRows[0]?.created_by, 100);
  assert.equal(reviewRows[0]?.status, "approved");
});

test("approval leaves an already-active verified user's permissions untouched", async () => {
  const active = verifiedRecord(-100, 501);
  active.permissions = {
    ...DEFAULT_VERIFIED_PERMISSIONS,
    bypass_antispam: false,
    can_send_media: false,
  };
  verifiedRows.push(active);
  await recordVerifiedTagObservation({
    groupId: -100,
    userId: 501,
    observedTag: "Verificada",
    status: "pending",
  });
  let localSyncCalls = 0;
  const result = await approveVerifiedTagCandidate({
    api: mockMemberApi(makeMember("member", "Verificada")),
    groupId: -100,
    userId: 501,
    actorUserId: 100,
    recognizedTags: ["Verificada"],
    authorize: async () => true,
    syncLocal: async () => {
      localSyncCalls += 1;
    },
  });

  assert.equal(result.status, "already-verified");
  assert.equal(verifiedRows.length, 1);
  assert.equal(verifiedRows[0]?.permissions.bypass_antispam, false);
  assert.equal(verifiedRows[0]?.permissions.can_send_media, false);
  assert.equal(localSyncCalls, 1);
  assert.equal(reviewRows[0]?.status, "matched");
});

test("an unauthorized actor cannot approve a candidate or call Telegram", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });
  let telegramCalls = 0;

  await assert.rejects(
    approveVerifiedTagCandidate({
      api: mockMemberApi(makeMember("member", "Verificada"), () => {
        telegramCalls += 1;
      }),
      groupId: -100,
      userId: 501,
      actorUserId: 999,
      recognizedTags: ["Verificada"],
      authorize: async () => false,
      syncLocal: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof VerifiedTagApprovalError &&
      error.code === "UNAUTHORIZED",
  );

  assert.equal(telegramCalls, 0);
  assert.equal(verifiedRows.length, 0);
  assert.equal(reviewRows[0]?.status, "pending");
});

test("manual approval reactivates a revoked record without resetting its permissions", async () => {
  const revoked = verifiedRecord(-100, 501, true);
  revoked.permissions = {
    ...DEFAULT_VERIFIED_PERMISSIONS,
    bypass_antispam: false,
    can_send_links: false,
  };
  verifiedRows.push(revoked);
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });
  const result = await approveVerifiedTagCandidate({
    api: mockMemberApi(makeMember("member", "Verificada")),
    groupId: -100,
    userId: 501,
    actorUserId: 100,
    recognizedTags: ["Verificada"],
    authorize: async () => true,
    syncLocal: async () => undefined,
  });

  assert.equal(result.status, "approved");
  assert.equal(verifiedRows.length, 1);
  assert.equal(verifiedRows[0]?.verified, true);
  assert.equal(verifiedRows[0]?.revoked_at, null);
  assert.equal(verifiedRows[0]?.permissions.bypass_antispam, false);
  assert.equal(verifiedRows[0]?.permissions.can_send_links, false);
});

test("approval does not proceed when the live tag is no longer recognized", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  await assert.rejects(
    approveVerifiedTagCandidate({
      api: mockMemberApi(makeMember("member")),
      groupId: -100,
      userId: 501,
      actorUserId: 100,
      recognizedTags: ["Verificada"],
      authorize: async () => true,
      syncLocal: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof VerifiedTagApprovalError &&
      error.code === "TAG_NOT_CONFIRMED",
  );

  assert.equal(verifiedRows.length, 0);
  assert.equal(reviewRows[0]?.status, "tag_absent");
});

test("Telegram errors return an uncertain result and do not imply missing tags", async () => {
  await observeVerifiedMemberTag({
    groupId: -100,
    member: makeMember("member", "Verificada"),
    recognizedTags: ["Verificada"],
  });

  const result = await approveVerifiedTagCandidate({
    api: mockMemberApi(new Error("Telegram request failed")),
    groupId: -100,
    userId: 501,
    actorUserId: 100,
    recognizedTags: ["Verificada"],
    authorize: async () => true,
    syncLocal: async () => undefined,
  });

  assert.equal(result.status, "uncertain");
  assert.equal(reviewRows[0]?.status, "pending");
  assert.equal(verifiedRows.length, 0);
  assert.ok(
    Array.from(auditRows.values()).some(
      (event) =>
        event.event_type === "CHECK_FAILED" &&
        event.current_status === "uncertain" &&
        event.failure_code === "TELEGRAM_ERROR",
    ),
  );
});
