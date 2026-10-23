import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalPath,
  isSameOrInside,
  jsonErrorLine,
  parseJsonQuietly,
  samePath,
} from "./install-lib.mjs";

const SECRET = "sk-sentinel-never-print";

function scratch() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-lib-test-")));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("jsonErrorLine is undefined for valid JSON and finds the faulty line otherwise", () => {
  assert.equal(jsonErrorLine('{"a": [1, 2.5e3, true, null, "x\\u00e9"]}'), undefined);
  assert.equal(jsonErrorLine("[]"), undefined);
  assert.equal(jsonErrorLine('{\n  "a": 1,\n}\n'), 3);
  assert.equal(jsonErrorLine(`{\n  "key": '${SECRET}'\n}`), 2);
  assert.equal(jsonErrorLine('{\n"a": 1\n}\n// comment'), 4);
  assert.equal(jsonErrorLine('﻿{"a": 1}'), 1);
  assert.equal(jsonErrorLine('{"a": "unterminated'), 1);
  assert.equal(jsonErrorLine(""), 1);
});

test("parseJsonQuietly never returns the parse error's text", () => {
  const result = parseJsonQuietly(`{\n "apiKey": '${SECRET}' }`);
  assert.deepEqual(result, { errorLine: 2 });
  assert.deepEqual(parseJsonQuietly('{"a":1}'), { value: { a: 1 } });
});

test("canonicalPath: trailing slashes, dot segments and symlinks name the same home", () => {
  const { dir, done } = scratch();
  try {
    const home = path.join(dir, ".paseo");
    mkdirSync(home);
    const link = path.join(dir, "link-to-paseo");
    symlinkSync(home, link);
    for (const alias of [`${home}/`, `${home}//`, `${dir}/./.paseo`, `${dir}/x/../.paseo`, link]) {
      assert.equal(canonicalPath(alias), home, alias);
      assert.ok(samePath(alias, home), alias);
    }
    assert.equal(canonicalPath(path.join(link, "new", "dir/")), path.join(home, "new", "dir"));
    assert.ok(isSameOrInside(path.join(link, "sub"), home));
    assert.ok(!isSameOrInside(`${home}-bozeo`, home));
  } finally {
    done();
  }
});

test("canonicalPath folds case on macOS and Windows only", () => {
  const { dir, done } = scratch();
  try {
    const upper = path.join(dir, ".PASEO");
    const lower = path.join(dir, ".paseo");
    assert.equal(samePath(upper, lower, "darwin"), true);
    assert.equal(samePath(upper, lower, "win32"), true);
    assert.equal(samePath(upper, lower, "linux"), false);
  } finally {
    done();
  }
});

test("canonicalPath rejects values that are not usable paths", () => {
  assert.throws(() => canonicalPath(""));
  assert.throws(() => canonicalPath("/a\nb"));
});
