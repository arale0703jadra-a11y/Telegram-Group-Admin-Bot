import assert from "node:assert/strict";
import test from "node:test";
import { menuNavigation } from "../src/menus/index.js";
import type { MyContext } from "../src/types.js";

function createCallbackContext(data: string): {
  ctx: MyContext;
  answers: string[];
} {
  const answers: string[] = [];
  const callbackQuery = {
    id: "cb-test",
    chat_instance: "chat-instance-test",
    from: { id: 1, is_bot: false, first_name: "Test" },
    data,
  };
  const ctx = {
    update: { callback_query: callbackQuery },
    callbackQuery,
    answerCallbackQuery: async (text?: string) => {
      if (text) answers.push(text);
    },
  } as unknown as MyContext;
  return { ctx, answers };
}

test("malformed ZEUS menu callbacks are answered instead of leaving Telegram loading", async () => {
  const { ctx, answers } = createCallbackContext("menu:invalid");
  let nextCalled = false;

  await menuNavigation.middleware()(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.match(answers[0] ?? "", /botón ya no es válido/);
});

test("callbacks belonging to other handlers continue through the middleware chain", async () => {
  const { ctx, answers } = createCallbackContext("ma:cancel");
  let nextCalled = false;

  await menuNavigation.middleware()(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(answers, []);
});
