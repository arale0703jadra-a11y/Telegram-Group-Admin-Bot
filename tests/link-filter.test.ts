import assert from "node:assert/strict";
import test from "node:test";
import { inspectLinks } from "../src/filters/link-filter.js";

test("detects web URLs and shortener domains", () => {
  for (const text of [
    "https://example.com/path",
    "www.example.com",
    "bit.ly/abc123",
    "example.com",
  ]) {
    assert.equal(inspectLinks(text).hasUnauthorizedLink, true, text);
  }
});

test("normalizes obfuscated protocols, dots, zero-width characters, and homoglyphs", () => {
  assert.equal(inspectLinks("hxxps://evil[.]com/a").hasUnauthorizedLink, true);
  assert.equal(inspectLinks("evil\u200b.com").hasUnauthorizedLink, true);
  assert.equal(inspectLinks("t[.]mе/+invite").hasUnauthorizedInvite, true);
  assert.equal(inspectLinks("https://例え.テスト").hasUnauthorizedLink, true);
});

test("detects Telegram invitation links and hidden text links", () => {
  assert.equal(inspectLinks("https://t.me/+invite").hasUnauthorizedInvite, true);
  assert.equal(
    inspectLinks("", [{ type: "text_link", offset: 0, length: 5, url: "https://evil.com" }])
      .hasUnauthorizedLink,
    true,
  );
});

test("whitelists a configured domain and its subdomains", () => {
  const options = { whitelist: ["official.example", "@official_channel"] };
  assert.equal(
    inspectLinks("https://news.official.example/page", [], options)
      .hasUnauthorizedLink,
    false,
  );
  assert.equal(
    inspectLinks("https://notofficial.example/page", [], options)
      .hasUnauthorizedLink,
    true,
  );
});

test("a Telegram channel whitelist does not allow every Telegram invite", () => {
  const options = { whitelist: ["https://t.me/official_channel"] };
  assert.equal(
    inspectLinks("https://t.me/official_channel", [], options)
      .hasUnauthorizedLink,
    false,
  );
  assert.equal(
    inspectLinks("https://t.me/+unknown_invite", [], options)
      .hasUnauthorizedLink,
    true,
  );
});

test("does not treat email addresses as links or allow URL userinfo to hide a host", () => {
  assert.equal(inspectLinks("contact@example.com").hasLink, false);
  assert.equal(
    inspectLinks("https://official.example@evil.example", [], {
      whitelist: ["official.example"],
    }).hasUnauthorizedLink,
    true,
  );
});

test("channel mentions are opt-in to avoid blocking ordinary user mentions", () => {
  assert.equal(
    inspectLinks("@channel_name", [], { blockMentions: false }).hasLink,
    false,
  );
  assert.equal(
    inspectLinks("@channel_name", [], { blockMentions: true }).blockedMention,
    "channel_name",
  );
  assert.equal(
    inspectLinks("@official_channel", [], {
      blockMentions: true,
      whitelist: ["@official_channel"],
    }).blockedMention,
    undefined,
  );
});
