import test from "node:test";
import assert from "node:assert";
import { validateMarkdownUpload, splitSections, hashContent, estimateTokens, MAX_MD_BYTES } from "./lib/guidelines.js";

const md = `# Title\n\nIntro text.\n\n## Greeting\n\nSay hello.\n\n### Warm openers\n\nHi there.\n\n## Closing\n\nSay goodbye.\n`;

test("sections split by headings with stable ids + paths", () => {
  const secs = splitSections(md);
  assert.deepEqual(secs.map((s) => s.id), ["title", "greeting", "warm-openers", "closing"]);
  assert.equal(secs[2].path, "Title / Greeting / Warm openers");
  assert.equal(secs[2].level, 3);
});

test("duplicate headings get unique ids", () => {
  const secs = splitSections(`# A\n\n## Notes\n\nx\n\n## Notes\n\ny\n`);
  assert.deepEqual(secs.map((s) => s.id), ["a", "notes", "notes-2"]);
});

test("upload validation: extension, mime, size, empty", () => {
  const good = { name: "g.md", mime: "text/markdown", size: 10, buffer: Buffer.from("# Hi") };
  assert.equal(validateMarkdownUpload(good), "# Hi");
  assert.throws(() => validateMarkdownUpload({ ...good, name: "g.pdf" }), /Only \.md/);
  assert.throws(() => validateMarkdownUpload({ ...good, name: "g.txt" }), /Only \.md/);
  assert.throws(() => validateMarkdownUpload({ ...good, mime: "application/pdf" }), /MIME/);
  assert.throws(() => validateMarkdownUpload({ ...good, size: MAX_MD_BYTES + 1 }), /too large/);
  assert.throws(() => validateMarkdownUpload({ ...good, buffer: Buffer.from("   ") }), /empty/);
  const mdUpper = validateMarkdownUpload({ ...good, name: "G.MARKDOWN", mime: "text/plain" });
  assert.equal(mdUpper, "# Hi");
});

test("content hash stable, tokens estimated", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
  assert.equal(estimateTokens("a".repeat(400)), 100);
});
