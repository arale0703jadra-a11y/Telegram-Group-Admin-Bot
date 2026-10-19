import assert from "node:assert/strict";
import test from "node:test";
import { inspectProfile } from "../src/filters/profile-checker.js";

test("does not flag an ordinary profile without configured prohibited terms", () => {
  assert.equal(
    inspectProfile(
      { firstName: "María", lastName: "García", username: "maria_g" },
      [],
    ),
    undefined,
  );
});

test("detects URL links and channel mentions in profile fields", () => {
  assert.equal(
    inspectProfile({ firstName: "visit https://evil.example" }, []),
    "profile-link",
  );
  assert.equal(
    inspectProfile({ firstName: "@spam_channel" }, []),
    "profile-link",
  );
});

test("matches configured terms despite diacritics, homoglyphs, or punctuation", () => {
  assert.match(
    inspectProfile({ firstName: "А.b.u.s.e" }, ["abuse"]) ?? "",
    /^profile-term:/,
  );
});

test("allows a profile link on the configured whitelist", () => {
  assert.equal(
    inspectProfile(
      { firstName: "https://news.official.example" },
      [],
      ["official.example"],
    ),
    undefined,
  );
});
