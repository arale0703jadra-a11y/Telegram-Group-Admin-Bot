import assert from "node:assert/strict";
import test from "node:test";
import { buildPromotionMessage } from "../src/filters/messages.js";
import { initialPromotionConfig } from "../src/storage/initial.js";

test("promotion moderation response contains verification guidance only", () => {
  const config = initialPromotionConfig();
  const message = buildPromotionMessage(config);

  assert.equal(message.includes(config.messages.verificationRequired), true);
  assert.equal(message.includes("Verifícate con:"), true);
  assert.equal(message.includes("@DanielRF25"), true);
  assert.equal(message.includes("Promoción no autorizada"), false);
  assert.equal(message.includes("Tu mensaje fue eliminado"), false);
  assert.equal(message.includes("silenciado"), false);
  assert.equal(message.includes("enlaces promocionales"), false);
});
