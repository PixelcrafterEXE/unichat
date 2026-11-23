// node --test (via tsx): Discord's markdown dialect -> tree (issue #98).   cd apps/ui && npx tsx --test src/markup.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { hasMarkup, inline, parse, plain } from "./markup";

test("emphasis, combinations, underline, strike, spoilers, escapes", () => {
  assert.deepEqual(inline("**bold** *it* _it_ __u__ ~~s~~"), [{ t: "b", c: ["bold"] }, " ", { t: "i", c: ["it"] }, " ", { t: "i", c: ["it"] }, " ", { t: "u", c: ["u"] }, " ", { t: "s", c: ["s"] }]);
  assert.deepEqual(inline("***both***"), [{ t: "b", c: [{ t: "i", c: ["both"] }] }]);
  assert.deepEqual(inline("__*under it*__"), [{ t: "u", c: [{ t: "i", c: ["under it"] }] }]);
  assert.deepEqual(inline("a ||secret **x**|| b"), ["a ", { t: "spoiler", c: ["secret ", { t: "b", c: ["x"] }] }, " b"]);
  assert.deepEqual(inline("\\*not italic\\*"), ["*not italic*"]);
  assert.deepEqual(inline("snake_case_name and 2*3*4"), ["snake_case_name and 2", { t: "i", c: ["3"] }, "4"], "Discord itself italicises 2*3*4; snake_case stays");
  assert.deepEqual(inline("a * b * c"), ["a * b * c"], "a lone star with spaces is no emphasis");
  assert.deepEqual(inline("**unclosed"), ["**unclosed"]);
});

test("code: inline and fenced; nothing inside is markup", () => {
  assert.deepEqual(inline("run `npm i **x**` now"), ["run ", { t: "code", v: "npm i **x**" }, " now"]);
  assert.deepEqual(inline("``a ` b``"), [{ t: "code", v: "a ` b" }]);
  assert.deepEqual(parse("before\n```js\nconst a = 1; // **no**\n```\nafter"), [
    { t: "p", c: ["before"] }, { t: "pre", v: "const a = 1; // **no**", lang: "js" }, { t: "p", c: ["after"] }]);
  assert.deepEqual(parse("```one line```"), [{ t: "pre", v: "one line" }]);
});

test("headings, subtext, quotes, lists, at line starts only", () => {
  assert.deepEqual(parse("# **Heading**"), [{ t: "h", level: 1, c: [{ t: "b", c: ["Heading"] }] }]);
  assert.deepEqual(parse("## Two\n### Three\n#### four"), [{ t: "h", level: 2, c: ["Two"] }, { t: "h", level: 3, c: ["Three"] }, { t: "p", c: ["#### four"] }]);
  assert.deepEqual(parse("not # a heading"), [{ t: "p", c: ["not # a heading"] }]);
  assert.deepEqual(parse("-# small print"), [{ t: "sub", c: ["small print"] }]);
  assert.deepEqual(parse("> quoted\n> more\nafter"), [{ t: "quote", c: [{ t: "p", c: ["quoted\nmore"] }] }, { t: "p", c: ["after"] }]);
  assert.deepEqual(parse("intro\n>>> all\nof this\n```\ncode\n```"), [{ t: "p", c: ["intro"] }, { t: "quote", c: [{ t: "p", c: ["all\nof this"] }, { t: "pre", v: "code" }] }]);
  assert.deepEqual(parse("- one\n* two\n  - nested\n1. first"), [{ t: "list", items: [
    { indent: 0, marker: "•", c: ["one"] }, { indent: 0, marker: "•", c: ["two"] }, { indent: 1, marker: "•", c: ["nested"] }, { indent: 0, marker: "1.", c: ["first"] }] }]);
  assert.deepEqual(parse("-not a list"), [{ t: "p", c: ["-not a list"] }]);
});

test("links: masked links carry their destination; only http(s); bare and <suppressed> URLs; URLs keep their underscores", () => {
  assert.deepEqual(inline("see [the docs](https://example.org/a_b_c)"), ["see ", { t: "link", href: "https://example.org/a_b_c", c: ["the docs"] }]);
  assert.deepEqual(inline("[x](javascript:alert(1))"), ["[x](javascript:alert(1))"], "never a script link");
  assert.deepEqual(inline("<https://x.org/a>"), [{ t: "url", href: "https://x.org/a" }]);
  assert.deepEqual(inline("go to https://x.org/some_path_here."), ["go to ", { t: "url", href: "https://x.org/some_path_here" }, "."]);
});

test("plain text stays plain: hasMarkup and plain()", () => {
  assert.equal(hasMarkup("hello there, how are you?"), false);
  assert.equal(hasMarkup("price 3.50 - ok"), false);
  assert.equal(hasMarkup("**hi**"), true); assert.equal(hasMarkup("line\n# head"), true); assert.equal(hasMarkup("1. first"), true);
  assert.equal(plain("# **Heading** with ||spoiler||"), "Heading with ▒▒▒");
});
