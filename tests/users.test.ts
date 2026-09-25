import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliseEmail } from "../src/users.ts";

test("emails are trimmed and lower-cased", () => {
  assert.equal(normaliseEmail("  Friend@Gmail.com "), "friend@gmail.com");
});

test("anything that cannot be an email address is refused", () => {
  for (const value of ["", "friend", "friend@", "@gmail.com", "friend@gmail", "a b@gmail.com", '"x"@gmail.com', "<x>@gmail.com"]) {
    assert.equal(normaliseEmail(value), null, value);
  }
  assert.equal(normaliseEmail(`${"a".repeat(250)}@x.co`), null);
});
