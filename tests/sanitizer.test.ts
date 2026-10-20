import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeIncomingText } from "../src/utils/sanitizer.js";

test("sanitizer removes control and bidi characters", () => {
  const input = "ab\u0000\u202Ecd";
  const output = sanitizeIncomingText(input);
  assert.equal(output, "abcd");
});

test("sanitizer flattens HTML and markdown wrappers without discarding filterable text", () => {
  const sanitized = sanitizeIncomingText(
    "<b>venta</b> **de** `contenido` <script>alert(1)</script>",
  );
  assert.match(sanitized, /venta/u);
  assert.match(sanitized, /de/u);
  assert.match(sanitized, /contenido/u);
  assert.match(sanitized, /alert\(1\)/u);
  assert.doesNotMatch(sanitized, /<\s*\/?\s*(?:b|script)\b/iu);
  assert.doesNotMatch(sanitized, /[*`]/u);
});

test("sanitizer validates length and applies a hard maximum", () => {
  assert.equal(sanitizeIncomingText("abcdef", 3), "abc");
  assert.throws(() => sanitizeIncomingText("text", -1), /SANITIZER_MAX_LENGTH_INVALID/u);
});
