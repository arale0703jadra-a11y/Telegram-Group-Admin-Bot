import assert from "node:assert/strict";
import test from "node:test";
import { detectIllegalContent } from "../src/filters/illegal-detector.js";
import { inspectLinks } from "../src/filters/link-filter.js";
import { getScannableMessageContent } from "../src/filters/message-content.js";

test("extracts forwarded text without treating an isolated phrase as an actionable offer", () => {
  const forwardedMessage = {
    text: "pornografia infantil",
    forward_from: { id: 123, first_name: "Original author" },
  };
  const content = getScannableMessageContent(forwardedMessage);

  const detection = detectIllegalContent(content.text, [], { forwarded: true });
  assert.equal(content.text, "pornografia infantil");
  assert.equal(detection.risk, "medium");
  assert.equal(detection.critical, false);
});

test("extracts forwarded captions and caption entities for link inspection", () => {
  const forwardedMessage = {
    caption: "Mira esto",
    caption_entities: [
      {
        type: "text_link" as const,
        offset: 0,
        length: 5,
        url: "https://untrusted.example",
      },
    ],
    forward_from_chat: {
      id: -100123,
      title: "Original channel",
      type: "channel" as const,
    },
  };
  const content = getScannableMessageContent(forwardedMessage);

  assert.equal(
    inspectLinks(content.text, content.entities).hasUnauthorizedLink,
    true,
  );
});
