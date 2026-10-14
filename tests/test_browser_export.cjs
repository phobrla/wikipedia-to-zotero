const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("browser export follows continuation and downloads complete lists", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "export_saved_lists.js"), "utf8");
  let downloaded;
  let blob;
  const calls = [];
  const errors = [];
  const responses = [
    { query: { readinglists: [{ id: 1, name: "Example", size: 2 }] }, continue: { rlcontinue: "next" } },
    { query: { readinglists: [] } },
    { query: { readinglistentries: [{ id: 1, listId: 1 }] }, continue: { rlecontinue: "next" } },
    { query: { readinglistentries: [{ id: 2, listId: 1 }] } },
  ];
  const link = { click() { downloaded = this.download; }, remove() {} };
  const context = {
    location: { protocol: "https:", hostname: "en.wikipedia.org" },
    URLSearchParams,
    Blob,
    URL: {
      createObjectURL(value) { blob = value; return "blob:synthetic"; },
      revokeObjectURL() {},
    },
    document: { createElement: () => link, body: { appendChild() {} } },
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => responses.shift() };
    },
    console: { info() {}, error(...args) { errors.push(args); } },
    setTimeout(callback) { callback(); },
  };
  await vm.runInNewContext(source, context);
  assert.deepEqual(errors, []);
  assert.equal(downloaded, "wikipedia-saved-snapshot.json");
  const snapshot = JSON.parse(await blob.text());
  assert.equal(snapshot.entries.length, 2);
  assert.match(calls[1], /rlcontinue=next/);
  assert.match(calls[3], /rlecontinue=next/);
  assert.ok(calls.every((url) => url.startsWith("/w/api.php?")));
});

test("browser export rejects incomplete source without downloading", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "export_saved_lists.js"), "utf8");
  const errors = [];
  const responses = [
    { query: { readinglists: [{ id: 1, name: "Example", size: 2 }] } },
    { query: { readinglistentries: [{ id: 1, listId: 1 }] } },
  ];
  await vm.runInNewContext(source, {
    location: { protocol: "https:", hostname: "en.wikipedia.org" },
    URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => responses.shift() }),
    console: { info() {}, error(...args) { errors.push(args); } },
  });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /List sizes changed/);
});
