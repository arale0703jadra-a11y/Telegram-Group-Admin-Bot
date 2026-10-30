import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiCooldown,
  TtlCache,
  createSecurityCaches,
} from "../src/utils/member-cache.js";
import type { MemberLookupApi } from "../src/utils/member-cache.js";
import type { ChatMember } from "@grammyjs/types";

function member(status: string): ChatMember {
  return { status } as ChatMember;
}

function adminMember(): ChatMember {
  return {
    status: "administrator",
    can_restrict_members: true,
    can_delete_messages: false,
  } as unknown as ChatMember;
}

function countingApi(memberValue: ChatMember | Error): MemberLookupApi & { calls: number } {
  return {
    calls: 0,
    async getChatMember() {
      this.calls += 1;
      if (memberValue instanceof Error) throw memberValue;
      return structuredClone(memberValue);
    },
  };
}

function rateLimitError(retryAfter: number): Error {
  const error = new Error("Too Many Requests") as Error & Record<string, unknown>;
  error.error_code = 429;
  error.parameters = { retry_after: retryAfter };
  return error;
}

test("TtlCache keeps values until TTL and expires them afterwards", () => {
  let now = 1_000;
  const cache = new TtlCache<number>(500, 10, () => now);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  now += 499;
  assert.equal(cache.get("a"), 1);
  now += 2;
  assert.equal(cache.get("a"), undefined);
});

test("TtlCache evicts the oldest entry when the maximum size is reached", () => {
  const cache = new TtlCache<number>(60_000, 2, () => 0);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});

test("TtlCache delete is exact and does not affect prefixed keys", () => {
  const cache = new TtlCache<number>(60_000, 10, () => 0);
  cache.set("chat:1", 1);
  cache.set("chat:12", 12);
  cache.delete("chat:1");
  assert.equal(cache.get("chat:1"), undefined);
  assert.equal(cache.get("chat:12"), 12);
  cache.deleteByPrefix("chat:");
  assert.equal(cache.get("chat:12"), undefined);
});

test("ApiCooldown never shortens a longer pause and expires by time", () => {
  let now = 0;
  const cooldown = new ApiCooldown(() => now, 30_000);
  cooldown.pause("100", 20);
  cooldown.pause("100", 2);
  assert.equal(cooldown.isPaused("100"), true);
  now = 19_999;
  assert.equal(cooldown.isPaused("100"), true);
  now = 20_001;
  assert.equal(cooldown.isPaused("100"), false);
});

test("member lookups are cached and callers receive copies, not internal objects", async () => {
  let now = 0;
  const caches = createSecurityCaches({ now: () => now });
  const api = countingApi(member("member"));

  const first = await caches.getCachedChatMember(api, -100, 7);
  const second = await caches.getCachedChatMember(api, -100, 7);
  assert.equal(api.calls, 1);
  assert.equal(first?.status, "member");
  assert.equal(second?.status, "member");
  assert.notEqual(first, second);

  (first as { status: string }).status = "administrator";
  const third = await caches.getCachedChatMember(api, -100, 7);
  assert.equal(third?.status, "member");
});

test("cached member entries expire after the TTL and the API is consulted again", async () => {
  let now = 0;
  const caches = createSecurityCaches({ now: () => now, memberTtlMs: 10 });
  const api = countingApi(member("member"));
  await caches.getCachedChatMember(api, -100, 7);
  now = 11;
  await caches.getCachedChatMember(api, -100, 7);
  assert.equal(api.calls, 2);
});

test("failed lookups are not cached: the next attempt reaches the API again", async () => {
  const caches = createSecurityCaches();
  let fail = true;
  const api = {
    calls: 0,
    async getChatMember() {
      this.calls += 1;
      if (fail) throw new Error("network down");
      return member("member");
    },
  } as MemberLookupApi & { calls: number };

  assert.equal(await caches.getCachedChatMember(api, -100, 7), undefined);
  fail = false;
  const recovered = await caches.getCachedChatMember(api, -100, 7);
  assert.equal(recovered?.status, "member");
  assert.equal(api.calls, 2);
});

test("a 429 pauses member lookups for the chat until retry_after elapses", async () => {
  let now = 0;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const caches = createSecurityCaches({ now: () => now, maxPauseMs: 30_000 });
    const api = countingApi(rateLimitError(7));

    assert.equal(await caches.getCachedChatMember(api, -100, 7), undefined);
    assert.equal(api.calls, 1);
    assert.ok(warnings.some((warning) => warning.includes("429")));
    assert.ok(warnings.every((warning) => !warning.includes("-100")));

    // Durante la pausa no se llama a la API para ningún usuario del chat.
    assert.equal(await caches.getCachedChatMember(api, -100, 8), undefined);
    assert.equal(await caches.getCachedChatMember(api, -100, 9), undefined);
    assert.equal(api.calls, 1);

    // Terminada la pausa vuelve a consultarse.
    now = 7_001;
    const healthy = countingApi(member("member"));
    assert.equal((await caches.getCachedChatMember(healthy, -100, 9))?.status, "member");
  } finally {
    console.warn = originalWarn;
  }
});

test("bot rights are denied by default and cached after a successful lookup", async () => {
  let now = 0;
  const caches = createSecurityCaches({ now: () => now, rightsTtlMs: 60 });
  const api = countingApi(adminMember());

  const first = await caches.getCachedBotRights(api, -100, 42);
  assert.deepEqual(first, { canRestrict: true, canDelete: false });
  const second = await caches.getCachedBotRights(api, -100, 42);
  assert.deepEqual(second, { canRestrict: true, canDelete: false });
  assert.equal(api.calls, 1);

  now = 61;
  await caches.getCachedBotRights(api, -100, 42);
  assert.equal(api.calls, 2);
});

test("bot rights are denied without API calls while the chat is paused by 429", async () => {
  let now = 0;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const caches = createSecurityCaches({ now: () => now });
    const api = countingApi(rateLimitError(10));
    assert.deepEqual(await caches.getCachedBotRights(api, -100, 42), {
      canRestrict: false,
      canDelete: false,
    });
    assert.equal(api.calls, 1);
    assert.deepEqual(await caches.getCachedBotRights(api, -100, 42), {
      canRestrict: false,
      canDelete: false,
    });
    assert.equal(api.calls, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("non-admin bot members produce deny-all rights", async () => {
  const caches = createSecurityCaches();
  const api = countingApi(member("member"));
  assert.deepEqual(await caches.getCachedBotRights(api, -100, 42), {
    canRestrict: false,
    canDelete: false,
  });
});

test("invalidateSecurityCaches forces a fresh member lookup for that user only", async () => {
  const caches = createSecurityCaches();
  const api = countingApi(member("member"));
  await caches.getCachedChatMember(api, -100, 7);
  await caches.getCachedChatMember(api, -100, 8);
  caches.invalidateSecurityCaches(-100, 7);
  await caches.getCachedChatMember(api, -100, 7);
  await caches.getCachedChatMember(api, -100, 8);
  assert.equal(api.calls, 3);
});