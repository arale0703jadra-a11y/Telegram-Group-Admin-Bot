import assert from "node:assert/strict";
import test from "node:test";
import {
  callWithRetryAfter,
  runChatActionExclusive,
} from "../src/utils/safety.js";

function rateLimitError(retryAfter?: number): Error & {
  error_code: number;
  parameters?: { retry_after: number };
} {
  return Object.assign(new Error("Too Many Requests"), {
    error_code: 429,
    ...(retryAfter === undefined
      ? {}
      : { parameters: { retry_after: retryAfter } }),
  });
}

test("honors Telegram retry_after values above the previous cap", async () => {
  const delays: number[] = [];
  let calls = 0;

  const result = await callWithRetryAfter(
    async () => {
      calls += 1;
      if (calls === 1) throw rateLimitError(45);
      return "ok";
    },
    async (delay) => {
      delays.push(delay);
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [45_000]);
});

test("uses exponential backoff when a 429 omits retry_after", async () => {
  const delays: number[] = [];
  let calls = 0;

  await callWithRetryAfter(
    async () => {
      calls += 1;
      if (calls < 3) throw rateLimitError();
      return true;
    },
    async (delay) => {
      delays.push(delay);
    },
  );

  assert.deepEqual(delays, [1_000, 2_000]);
});

test("does not retry non-rate-limit errors or exceed the retry limit", async () => {
  let calls = 0;
  await assert.rejects(
    callWithRetryAfter(async () => {
      calls += 1;
      throw Object.assign(new Error("Bad Request"), { error_code: 400 });
    }, async () => {}),
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    callWithRetryAfter(async () => {
      calls += 1;
      throw rateLimitError(0);
    }, async () => {}),
  );
  assert.equal(calls, 4);
});

test("serializes simultaneous moderation actions for the same chat", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = runChatActionExclusive(42, async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = runChatActionExclusive(42, async () => {
    order.push("second-start");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});
