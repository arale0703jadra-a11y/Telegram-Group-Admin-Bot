import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFIED_PERMISSIONS,
  normalizeVerifiedPermissions,
} from "../src/services/verified-users.js";

test("verified permissions have the requested safe defaults", () => {
  assert.deepEqual(DEFAULT_VERIFIED_PERMISSIONS, {
    can_post: true,
    can_send_media: true,
    can_send_links: true,
    bypass_antispam: true,
    bypass_promotion_filter: true,
    bypass_illegal_filter: false,
    bypass_automatic_deletion: false,
  });
});

test("permission edits preserve unspecified values", () => {
  const permissions = normalizeVerifiedPermissions({ bypass_illegal_filter: true });
  assert.equal(permissions.bypass_illegal_filter, true);
  assert.equal(permissions.bypass_antispam, true);
  assert.equal(permissions.can_post, true);
});
