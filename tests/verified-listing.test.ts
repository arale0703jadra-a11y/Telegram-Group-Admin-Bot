import assert from "node:assert/strict";
import test from "node:test";
import type { VerifiedUser } from "../src/services/verified-users.js";

process.env.SUPABASE_URL = "https://verified-listing.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const realFetch = globalThis.fetch;
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const handlers = new Map<number, FetchHandler>();
const requests = new Map<number, Array<{ url: URL; init?: RequestInit }>>();

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const groupFilter = url.searchParams.get("group_id") ?? "";
    const groupId = Number(groupFilter.replace(/^eq\./u, ""));
    const groupRequests = requests.get(groupId) ?? [];
    groupRequests.push({ url, init });
    requests.set(groupId, groupRequests);
    const handler = handlers.get(groupId);
    if (!handler) throw new Error(`Unexpected verified-list request for ${groupId}`);
    return handler(input, init);
  }) as typeof fetch;

const {
  getVerifiedUsersPage,
  getVerifiedUsersListingPage,
  getRevokedVerifiedUsersPage,
  searchVerifiedUsers,
  VERIFIED_USERS_PAGE_SIZE,
  VERIFIED_USERS_HISTORY_PAGE_SIZE,
  VERIFIED_USERS_QUERY_TIMEOUT_MS,
} = await import("../src/services/verified-users.js");

test.after(() => {
  globalThis.fetch = realFetch;
});

function verifiedUser(
  userId: number,
  groupId = -1004321,
): VerifiedUser {
  return {
    id: `record-${userId}`,
    group_id: groupId,
    user_id: userId,
    username: `member${userId}`,
    display_name: `Member ${userId}`,
    verified: true,
    permissions: {
      can_post: true,
      can_send_media: true,
      can_send_links: true,
      bypass_antispam: false,
      bypass_promotion_filter: false,
      bypass_illegal_filter: false,
      bypass_automatic_deletion: false,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: 10,
    revoked_at: null,
    verification_method: userId % 2 === 0 ? "manual" : "detected_custom_title",
    valid_until: "2030-01-01T00:00:00.000Z",
  };
}

test("verified listing queries only one database page and retains the exact total", async () => {
  const groupId = -1004321;
  const rows = Array.from({ length: VERIFIED_USERS_PAGE_SIZE }, (_, index) =>
    verifiedUser(100 + index),
  );
  handlers.set(groupId, async () => {
    return new Response(JSON.stringify(rows), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "5-9/12",
      },
    });
  });

  const page = await getVerifiedUsersPage(
    groupId,
    1,
    new Date("2026-11-04T00:00:00.000Z"),
  );

  assert.equal(page.totalCount, 12);
  assert.equal(page.page, 1);
  assert.equal(page.users.length, VERIFIED_USERS_PAGE_SIZE);
  assert.equal(page.users[0]?.user_id, 100);
  const [request] = requests.get(groupId) ?? [];
  assert.equal(requests.get(groupId)?.length, 1);
  assert.equal(request?.url.searchParams.get("group_id"), "eq.-1004321");
  assert.equal(request?.url.searchParams.get("offset"), "5");
  assert.equal(request?.url.searchParams.get("limit"), "5");
  assert.ok(request?.url.searchParams.has("or"));
});

test("simultaneous requests for the same verified page share one Supabase request", async () => {
  const groupId = -1004322;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  handlers.set(groupId, async () => {
    await hold;
    return new Response(JSON.stringify([verifiedUser(123)]), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "0-0/1",
      },
    });
  });

  const first = getVerifiedUsersPage(groupId, 0);
  const second = getVerifiedUsersPage(groupId, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.get(groupId)?.length, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
});

test("search and revoked-history views are also paginated in Supabase", async () => {
  const searchGroupId = -1004325;
  const historyGroupId = -1004326;
  handlers.set(searchGroupId, async () => new Response(
    JSON.stringify([verifiedUser(201)]),
    {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "8-15/21",
      },
    },
  ));
  const revoked = { ...verifiedUser(202), revoked_at: "2026-01-02T00:00:00.000Z" };
  handlers.set(historyGroupId, async () => new Response(
    JSON.stringify([revoked]),
    {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "10-10/11",
      },
    },
  ));

  const [searchPage, historyPage] = await Promise.all([
    getVerifiedUsersListingPage(searchGroupId, 1, "alice"),
    getRevokedVerifiedUsersPage(historyGroupId, 1),
  ]);
  const searchRequest = requests.get(searchGroupId)?.[0];
  const historyRequest = requests.get(historyGroupId)?.[0];

  assert.equal(searchPage.totalCount, 21);
  assert.equal(searchPage.pageSize, 8);
  assert.equal(searchRequest?.url.searchParams.get("offset"), "8");
  assert.ok(searchRequest?.url.searchParams.get("or")?.includes("alice"));
  assert.equal(historyPage.totalCount, 11);
  assert.equal(historyPage.pageSize, VERIFIED_USERS_HISTORY_PAGE_SIZE);
  assert.equal(historyPage.users[0]?.revoked_at, revoked.revoked_at);
  assert.equal(historyRequest?.url.searchParams.get("offset"), "10");
  assert.ok(historyRequest?.url.searchParams.has("or"));
});

test("interactive search returns all matches through stable Supabase pages", async () => {
  const groupId = -1004327;
  const allRows = Array.from({ length: 21 }, (_, index) =>
    verifiedUser(300 + index, groupId),
  );
  handlers.set(groupId, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const rows = allRows.slice(offset, offset + limit);
    const last = offset + rows.length - 1;
    return new Response(JSON.stringify(rows), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": `${offset}-${last}/${allRows.length}`,
      },
    });
  });

  const pages = await Promise.all([
    searchVerifiedUsers(groupId, "@alice", 0),
    searchVerifiedUsers(groupId, "alice", 1),
    searchVerifiedUsers(groupId, "alice", 2),
  ]);
  const queried = requests.get(groupId) ?? [];

  assert.deepEqual(pages.map((page) => page.users.length), [8, 8, 5]);
  assert.deepEqual(pages.map((page) => page.totalCount), [21, 21, 21]);
  assert.deepEqual(pages.map((page) => page.page), [0, 1, 2]);
  assert.equal(queried.length, 3);
  assert.deepEqual(
    queried.map(({ url }) => url.searchParams.get("offset")),
    ["0", "8", "16"],
  );
  assert.ok(queried.every(({ url }) =>
    url.searchParams.get("group_id") === `eq.${groupId}` &&
    url.searchParams.get("or")?.includes("%alice%") &&
    url.searchParams.get("order") === "display_name.asc,user_id.asc",
  ));
  assert.ok(queried.every(({ url }) => url.searchParams.get("limit") === "8"));
  assert.equal(new Set(pages.flatMap((page) => page.users.map((user) => user.user_id))).size, 21);
});

test("consecutive searches are isolated by group and search term", async () => {
  const firstGroup = -1004328;
  const secondGroup = -1004329;
  handlers.set(firstGroup, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const term = url.searchParams.get("or") ?? "";
    const id = term.includes("alice") || term.includes("user_id.eq.401")
      ? 401
      : 402;
    return new Response(JSON.stringify([verifiedUser(id, firstGroup)]), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "0-0/1",
      },
    });
  });
  handlers.set(secondGroup, async () => new Response(
    JSON.stringify([verifiedUser(501, secondGroup)]),
    {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": "0-0/1",
      },
    },
  ));

  const [alice, bob, exactId, otherGroup] = await Promise.all([
    searchVerifiedUsers(firstGroup, "alice"),
    searchVerifiedUsers(firstGroup, "bob"),
    searchVerifiedUsers(firstGroup, "401"),
    searchVerifiedUsers(secondGroup, "alice"),
  ]);

  assert.equal(alice.users[0]?.user_id, 401);
  assert.equal(bob.users[0]?.user_id, 402);
  assert.equal(exactId.users[0]?.user_id, 401);
  assert.equal(otherGroup.users[0]?.user_id, 501);
  assert.equal(requests.get(firstGroup)?.length, 3);
  assert.equal(requests.get(secondGroup)?.length, 1);
  assert.ok(requests.get(firstGroup)?.[0]?.url.searchParams.get("or")?.includes("username.ilike.%alice%"));
  assert.ok(requests.get(firstGroup)?.[0]?.url.searchParams.get("or")?.includes("display_name.ilike.%alice%"));
  assert.ok(requests.get(firstGroup)?.[2]?.url.searchParams.get("or")?.includes("user_id.eq.401"));
  assert.ok(requests.get(firstGroup)?.every(({ url }) =>
    url.searchParams.get("group_id") === `eq.${firstGroup}`,
  ));
  assert.equal(
    requests.get(secondGroup)?.[0]?.url.searchParams.get("group_id"),
    `eq.${secondGroup}`,
  );
});

test("interactive search reports Supabase errors and aborts after five seconds", async () => {
  const errorGroupId = -1004330;
  const timeoutGroupId = -1004331;
  handlers.set(errorGroupId, async () => new Response(
    JSON.stringify({ message: "search unavailable", code: "XX000" }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  ));
  handlers.set(timeoutGroupId, async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });

  await assert.rejects(searchVerifiedUsers(errorGroupId, "alice"), (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "search unavailable",
  );
  const startedAt = Date.now();
  await assert.rejects(
    searchVerifiedUsers(timeoutGroupId, "alice"),
    /superó el límite de tiempo/u,
  );
  assert.ok(Date.now() - startedAt < VERIFIED_USERS_QUERY_TIMEOUT_MS + 1_000);
  assert.equal(
    requests.get(timeoutGroupId)?.[0]?.init?.signal?.aborted,
    true,
  );
});

test("slow Supabase listing is aborted at the configured deadline", async () => {
  const groupId = -1004323;
  handlers.set(groupId, async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });

  const startedAt = Date.now();
  await assert.rejects(
    getVerifiedUsersPage(groupId, 2),
    /superó el límite de tiempo/u,
  );
  assert.ok(Date.now() - startedAt < VERIFIED_USERS_QUERY_TIMEOUT_MS + 1_000);
  assert.equal(requests.get(groupId)?.length, 1);
  assert.equal(requests.get(groupId)?.[0]?.init?.signal?.aborted, true);
});

test("Supabase errors are surfaced instead of returning an empty or stale list", async () => {
  const groupId = -1004324;
  handlers.set(groupId, async () => new Response(
    JSON.stringify({ message: "database unavailable", code: "XX000" }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  ));

  await assert.rejects(getVerifiedUsersPage(groupId, 0), (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "database unavailable",
  );
});
