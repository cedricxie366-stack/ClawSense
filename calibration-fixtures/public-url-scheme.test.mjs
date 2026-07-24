import assert from "node:assert/strict";
import test from "node:test";
import { withProtocol } from "../dist/src/utils.js";

test("public URL protocol detection is case-insensitive", () => {
  assert.equal(withProtocol("HTTPS://Example.com/clawsense"), "HTTPS://Example.com/clawsense");
  assert.equal(withProtocol("HTTP://192.0.2.10:18789"), "HTTP://192.0.2.10:18789");
});
