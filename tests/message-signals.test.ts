import assert from "node:assert/strict";
import test from "node:test";
import { mediaKey, similarToRecent } from "../src/utils/message-signals.js";
import type { Message } from "@grammyjs/types";

/**
 * Pruebas aisladas de las señales de medios y repetición. No contactan con
 * Telegram ni leen configuración.
 */

function messageWith(partial: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: { id: -1001, type: "supergroup" }, ...partial } as Message;
}

test("mediaKey uses the largest photo size file id", () => {
  const message = messageWith({
    photo: [
      { file_id: "small", file_unique_id: "u1" },
      { file_id: "large", file_unique_id: "u2" },
    ],
  });
  assert.equal(mediaKey(message), "photo:large");
});

test("mediaKey identifies each supported media type by its file id", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ sticker: { file_id: "s1", file_unique_id: "su1", type: "regular", width: 1, height: 1 } }, "sticker:s1"],
    [{ animation: { file_id: "a1", file_unique_id: "au1", width: 1, height: 1, duration: 1 } }, "animation:a1"],
    [{ video: { file_id: "v1", file_unique_id: "vu1", width: 1, height: 1, duration: 1 } }, "video:v1"],
    [{ document: { file_id: "d1", file_unique_id: "du1", file_name: "x" } }, "document:d1"],
    [{ audio: { file_id: "au", file_unique_id: "auu1", duration: 1 } }, "audio:au"],
    [{ voice: { file_id: "vo1", file_unique_id: "vou1", duration: 1 } }, "voice:vo1"],
    [{ video_note: { file_id: "vn1", file_unique_id: "vnu1", length: 1, duration: 1 } }, "video_note:vn1"],
  ];
  for (const [partial, expected] of cases) {
    assert.equal(mediaKey(messageWith(partial)), expected);
  }
});

test("mediaKey returns undefined for text-only messages and for missing messages", () => {
  assert.equal(mediaKey(messageWith({ text: "hola" })), undefined);
  assert.equal(mediaKey(undefined), undefined);
});

test("identical media from different users shares the same key (repeated-media signal)", () => {
  const first = messageWith({ document: { file_id: "d1", file_unique_id: "du1", file_name: "x" } });
  const second = messageWith({ document: { file_id: "d1", file_unique_id: "du1", file_name: "x" } });
  assert.equal(mediaKey(first), mediaKey(second));
});

test("similarToRecent detects exact and near-identical repetitions", () => {
  assert.equal(similarToRecent("vendo productos baratos", ["vendo productos baratos"]), true);
  // 5 de 6 palabras en común => 0.833 >= 0.8 con >= 3 palabras compartidas.
  assert.equal(
    similarToRecent("hola buenos días a todos gente", ["hola buenos días a todos"]),
    true,
  );
});

test("similarToRecent ignores genuinely different messages and empty text", () => {
  assert.equal(similarToRecent("¿alguien recomienda un buen café?", ["vendo productos baratos"]), false);
  assert.equal(similarToRecent("", ["vendo productos baratos"]), false);
  assert.equal(similarToRecent("hola a todos", []), false);
});