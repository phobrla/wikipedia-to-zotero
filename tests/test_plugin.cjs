const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");
const core = require("../plugin/core.js");

function source() {
  return {
    lists: [
      { id: 1, name: "default", size: 1 },
      { id: 2, name: 'Reference, "quoted" \u03a9', size: 1 },
    ],
    entries: [
      { id: 11, listId: 1, project: "https://en.wikipedia.org",
        title: 'Example article, "quoted" \u03a9', created: "2020-01-01T02:00:00+02:00" },
      { id: 12, listId: 2, project: "https://en.wikipedia.org",
        title: 'Example article, "quoted" \u03a9', created: "2021-01-01T00:00:00Z" },
    ],
  };
}

function existing(key = "ABCD2345") {
  return { key, version: 3, itemType: "encyclopediaArticle", title: "Keep this title",
    url: core.articles(source())[0].url + "#History", dateAdded: "2025-01-01T00:00:00Z",
    dateModified: "2025-01-01T00:00:00Z", tags: [{ tag: "Existing", type: 1 }],
    extra: "My own notes", creators: [{ name: "Original author", creatorType: "author" }],
    collections: ["WXYZ2345"], relations: { "dc:relation": "https://example.org" } };
}

test("merge all folders and retain earliest and individual timestamps", () => {
  const [article] = core.articles(source());
  assert.equal(article.saved, "2020-01-01T00:00:00Z");
  assert.equal(article.memberships.length, 2);
  assert.equal(article.tags.length, 2);
  assert.equal(article.provenance.length, 3);
});

test("URL normalization retains language and rejects impostors", () => {
  assert.equal(core.identity("https://en.m.wikipedia.org/wiki/Example%20article#x"),
    core.identity("http://en.wikipedia.org/w/index.php?title=Example_article"));
  assert.notEqual(core.identity("https://en.wikipedia.org/wiki/A"),
    core.identity("https://bg.wikipedia.org/wiki/A"));
  for (const url of ["https://notwikipedia.org/wiki/A", "https://en.wikipedia.org:123/wiki/A",
    "https://user@en.wikipedia.org/wiki/A", "bad url"]) assert.equal(core.identity(url), null);
});

test("reject malformed and incomplete source before writing", () => {
  for (const mutate of [
    snapshot => snapshot.entries.pop(),
    snapshot => { snapshot.entries[1].id = 11; },
    snapshot => { snapshot.entries[1].listId = 999; },
    snapshot => { snapshot.entries[0].created = "2020-01-01"; },
    snapshot => { snapshot.entries[0].project = "https://example.org"; },
    snapshot => { snapshot.lists[0].name = "bad\nname"; },
    snapshot => { snapshot.entries[1].listId = 1; snapshot.lists[0].size = 2; snapshot.lists[1].size = 0; },
  ]) {
    const snapshot = source();
    mutate(snapshot);
    assert.throws(() => core.articles(snapshot));
  }
});

test("timestamps reject invalid calendar days instead of silently shifting the saved date", () => {
  for (const value of ["2021-02-30T12:00:00Z", "2020-01-01T24:00:00Z",
    "2020-01-01Z", "2020-01-01T12:00:00"]) {
    assert.throws(() => core.timestamp(value));
  }
  assert.equal(core.timestamp("2020-02-29T12:00:00Z"), "2020-02-29T12:00:00Z");
});

test("existing fields, tag types, collections and duplicates preserved", () => {
  const old = existing();
  const original = JSON.stringify(old);
  const planned = core.plan(source(), [old, existing("WXYZ2345")]);
  assert.equal(planned.length, 2);
  assert.equal(JSON.stringify(old), original);
  for (const item of planned) {
    assert.equal(item.operation, "update");
    assert.equal(item.data.title, old.title);
    assert.deepEqual(item.data.creators, old.creators);
    assert.deepEqual(item.data.collections, old.collections);
    assert.ok(item.data.tags.some(tag => tag.type === 1));
    assert.ok(item.data.extra.startsWith("My own notes\n"));
  }
  core.verify(planned, planned.map(item => item.data));
});

test("attachments never count as matching bibliography records", () => {
  const [item] = core.plan(source(), [{ ...existing(), itemType: "attachment" }]);
  assert.equal(item.operation, "create");
  assert.equal(item.data.itemType, "encyclopediaArticle");
  assert.equal(item.before, null);
});

test("existing Extra whitespace and original tags survive the merge and verification", () => {
  const old = { ...existing(), extra: "\nMy own notes\r\n\r\n" };
  const [planned] = core.plan(source(), [old]);
  assert.ok(planned.data.extra.startsWith(old.extra));
  for (const mutate of [
    item => { item.extra = item.extra.slice(old.extra.length); },
    item => { item.tags = item.tags.filter(tag => tag.tag !== "Existing"); },
    item => { item.tags.find(tag => tag.tag === "Existing").type = 0; },
  ]) {
    const stored = JSON.parse(JSON.stringify(planned.data));
    mutate(stored);
    assert.throws(() => core.verify([planned], [stored]));
  }
});

test("rerun matches imported records without creating duplicates", () => {
  const planned = core.plan(source(), []);
  const stored = planned.map(item => ({ ...item.data, key: "ABCD2345", version: 1 }));
  const repeated = core.plan(source(), stored);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].operation, "unchanged");
  core.verify(repeated, stored);
});

test("verification rejects lost dates, tags, provenance or original fields", () => {
  const planned = core.plan(source(), [existing()]);
  for (const mutate of [
    item => { item.dateAdded = "2022-01-01T00:00:00Z"; },
    item => { item.tags = []; },
    item => { item.extra = ""; },
    item => { item.title = "changed"; },
    item => { item.collections = []; },
  ]) {
    const stored = JSON.parse(JSON.stringify(planned[0].data));
    mutate(stored);
    assert.throws(() => core.verify(planned, [stored]));
  }
});

test("CSV losslessly round trips quoted Unicode cells and multiline provenance", () => {
  const csv = core.toCSV(source());
  assert.ok(csv.startsWith("\uFEFF"));
  const [original] = core.articles(source());
  const [restored] = core.articles(core.fromCSV(csv));
  assert.equal(restored.canonical, original.canonical);
  assert.equal(restored.title, original.title);
  assert.equal(restored.saved, original.saved);
  assert.deepEqual(restored.tags, original.tags);
  assert.deepEqual(new Set(restored.provenance), new Set(original.provenance));
});

test("CSV rejects tampered timestamps and malformed data", () => {
  const csv = core.toCSV(source());
  assert.throws(() => core.fromCSV(csv.replace("2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z")));
  assert.throws(() => core.fromCSV(csv.slice(0, -10)));
  assert.throws(() => core.fromCSV('title,url\nA,B\n'));
  const rows = csv.trimEnd().split("\r\n");
  assert.throws(() => core.fromCSV(csv + rows[1] + "\r\n"));
});

test("CSV interoperates both ways with the Python CLI", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wikipedia-plugin-test-"));
  try {
    const file = path.join(directory, "synthetic.csv");
    fs.writeFileSync(file, core.toCSV(source()));
    const python = process.env.PYTHON || "python";
    const result = spawnSync(python, ["-c", [
      "from pathlib import Path",
      "import sys",
      "import wikipedia_to_zotero as app",
      "path = Path(sys.argv[1])",
      "snapshot = app.snapshot_from_csv(path)",
      "assert len(app.articles_from_snapshot(snapshot)) == 1",
      "path.unlink()",
      "app.export_csv(path, snapshot)",
    ].join("\n"), file], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(core.articles(core.fromCSV(fs.readFileSync(file, "utf8"))).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

function deletionOptions(overrides = {}) {
  const snapshot = source();
  return {
    account: "ExampleUser", snapshot, backupVerified: true, importVerified: true,
    readCurrent: async () => ({ account: "ExampleUser", snapshot }),
    confirm: async () => false,
    teardown: async () => { throw new Error("Must not delete"); },
    isDisabled: async () => true,
    ...overrides,
  };
}

test("Keep/default never deletes originals or requests a destructive token", async () => {
  const result = await core.maybeDelete(deletionOptions());
  assert.deepEqual(result, { deleted: false });
});

test("missing verification blocks even presenting the delete prompt", async () => {
  for (const flags of [{ backupVerified: false }, { importVerified: false }]) {
    await assert.rejects(core.maybeDelete(deletionOptions({
      ...flags, confirm: async () => { throw new Error("Must not prompt"); },
    })), /blocked/);
  }
});

test("changed account, newly saved items, empty folders or timestamps block deletion", async () => {
  for (const mutate of [
    current => { current.account = "DifferentUser"; },
    current => { current.snapshot.lists.push({ id: 3, name: "New empty folder", size: 0 }); },
    current => { current.snapshot.entries[0].updated = "2026-01-01T00:00:00Z"; },
    current => { current.snapshot.entries[0].created = "2019-01-01T00:00:00Z"; },
  ]) {
    const current = { account: "ExampleUser", snapshot: source() };
    mutate(current);
    await assert.rejects(core.maybeDelete(deletionOptions({
      confirm: async () => true, readCurrent: async () => current,
    })), /changed/);
  }
});

test("confirmed unchanged import deletes exactly once and verifies afterward", async () => {
  const events = [];
  const result = await core.maybeDelete(deletionOptions({
    confirm: async () => { events.push("confirm"); return true; },
    readCurrent: async () => { events.push("read"); return { account: "ExampleUser", snapshot: source() }; },
    teardown: async () => { events.push("delete"); },
    isDisabled: async () => { events.push("verify"); return true; },
  }));
  assert.deepEqual(result, { deleted: true });
  assert.deepEqual(events, ["confirm", "read", "delete", "verify"]);
});

test("unverified deletion and network errors never appear successful", async () => {
  await assert.rejects(core.maybeDelete(deletionOptions({
    confirm: async () => true, teardown: async () => {}, isDisabled: async () => false,
  })), /could not be verified/);
  await assert.rejects(core.maybeDelete(deletionOptions({
    confirm: async () => true, teardown: async () => { throw new Error("Network failure"); },
  })), /Network failure/);
});

test("manifest is Zotero 10 compatible; bootstrap installs and cleans menus", async () => {
  const manifest = require("../plugin/manifest.json");
  assert.equal(manifest.applications.zotero.strict_min_version, "10.0");
  assert.equal(manifest.applications.zotero.strict_max_version, "10.0.*");
  assert.equal(manifest.applications.zotero.update_url,
    "https://raw.githubusercontent.com/phobrla/wikipedia-to-zotero/main/plugin/updates.json");
  const updates = require("../plugin/updates.json")
    .addons[manifest.applications.zotero.id].updates;
  assert.equal(updates[0].version, manifest.version);
  assert.equal(updates[0].applications.zotero.strict_min_version,
    manifest.applications.zotero.strict_min_version);
  assert.equal(updates[0].applications.zotero.strict_max_version,
    manifest.applications.zotero.strict_max_version);
  assert.equal(updates[0].update_link,
    `https://github.com/phobrla/wikipedia-to-zotero/releases/download/v${manifest.version}`
    + `/wikipedia-to-zotero-${manifest.version}.xpi`);
  const calls = [];
  const context = {
    Zotero: { initializationPromise: Promise.resolve(), getMainWindows: () => ["window"] },
    Services: { scriptloader: { loadSubScript(uri) {
      calls.push(uri);
      if (uri.endsWith("core.js")) context.WikipediaZoteroCore = core;
      else context.WikipediaZoteroPlugin = {
        init(value) { assert.equal(value, core); },
        addToWindow(window) { calls.push("add:" + window); },
        removeFromWindow(window) { calls.push("remove:" + window); },
        shutdown() { calls.push("shutdown"); },
      };
    } } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin/bootstrap.js"), "utf8"), context);
  await context.startup({ rootURI: "resource://synthetic/" });
  context.onMainWindowLoad({ window: "second" });
  context.onMainWindowUnload({ window: "second" });
  context.shutdown();
  assert.deepEqual(calls, ["resource://synthetic/core.js", "resource://synthetic/plugin.js",
    "add:window", "add:second", "remove:second", "shutdown"]);
});

test("adapter uses native exclusive private writes and never stores passwords", async () => {
  const written = new Map();
  const context = {
    TextEncoder,
    Components: { interfaces: { nsIFile: { NORMAL_FILE_TYPE: 0 } } },
    Zotero: { File: { pathToFile(file) {
      return { create(type, permissions) {
        assert.equal(type, 0);
        assert.equal(permissions, 0o600);
        if (written.has(file)) throw new Error("Exists");
        written.set(file, "");
      } };
    } } },
    IOUtils: {
      async writeUTF8(file, text, options) {
        assert.equal(options.mode, "overwrite");
        assert.equal(options.flush, true);
        written.set(file, text);
      },
      async read(file) { return new TextEncoder().encode(written.get(file)); },
    },
  };
  vm.createContext(context);
  const adapter = fs.readFileSync(path.join(__dirname, "../plugin/plugin.js"), "utf8");
  vm.runInContext(adapter, context);
  await context.WikipediaZoteroPlugin.writePrivate("private.csv", "\uFEFFsynthetic");
  await assert.rejects(context.WikipediaZoteroPlugin.writePrivate("private.csv", "replace"), /Exists/);
  assert.ok(adapter.includes("newCookieContext"));
  assert.ok(adapter.includes("context.dispose()"));
  assert.ok(!adapter.includes("Wikipedia_Password"));
});

function adapterWith(context) {
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../plugin/plugin.js"), "utf8"), context);
  const plugin = context.WikipediaZoteroPlugin;
  plugin.init(core);
  return plugin;
}

test("adapter keeps originals as the default deletion-prompt choice", () => {
  const plugin = adapterWith({ Services: { prompt: {
    BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_TITLE_IS_STRING: 127, BUTTON_POS_0_DEFAULT: 0,
    confirmEx(window, title, message, flags, first, second) {
      assert.equal(flags, 127 + 256 * 127);
      assert.equal(first, "Keep originals");
      assert.equal(second, "Delete ALL originals...");
      return 0;
    },
  } } });
  assert.equal(plugin.choose(null, "Deletion", "Synthetic", "Keep originals",
    "Delete ALL originals..."), false);
});

test("adapter treats an account with no lists as read-only and closes its session", async () => {
  let closed = 0, progressClosed = 0;
  const notices = [];
  const plugin = adapterWith({ Zotero: { ProgressWindow: class {
    ItemProgress = class { setText() {} setProgress() {} };
    changeHeadline() {}
    show() {}
    close() { progressClosed++; }
  } } });
  plugin.alert = (window, message) => notices.push(message);
  plugin.connect = async () => ({ account: "Synthetic", close() { closed++; } });
  plugin.readSnapshot = async () => {
    const error = new Error("No lists");
    error.code = "readinglists-db-error-not-set-up";
    throw error;
  };
  plugin.importSnapshot = async () => { throw new Error("Must not import"); };
  await plugin.run(null, "import");
  assert.equal(closed, 1);
  assert.equal(progressClosed, 1);
  assert.ok(notices[0].includes("Nothing was imported or deleted"));
  assert.equal(plugin.busy, false);
  assert.equal(plugin.session, null);
});

test("failed sign-in cleans up its isolated session and reports cancellation", async () => {
  let closed = 0;
  const notices = [];
  const plugin = adapterWith({});
  plugin.alert = (window, message) => notices.push(message);
  plugin.connect = async () => {
    plugin.session = { close() { closed++; } };
    throw new Error("Wikipedia sign-in cancelled.");
  };
  await plugin.run(null, "import");
  assert.equal(closed, 1);
  assert.ok(notices[0].includes("Wikipedia sign-in cancelled"));
  assert.equal(plugin.busy, false);
  assert.equal(plugin.session, null);
});

test("Wikipedia request bodies never log the destructive CSRF token", async () => {
  let disposed = 0;
  const plugin = adapterWith({
    URLSearchParams,
    Zotero: {
      HTTP: {
        newCookieContext: () => ({ id: 7, dispose() { disposed++; } }),
        async request(method, url, options) {
          assert.equal(options.userContextId, 7);
          assert.equal(options.logBodyLength, 0);
          if (method === "POST") assert.ok(options.body.includes("token=synthetic-token"));
          return { response: { query: { userinfo: { name: "Synthetic", id: 1 } } } };
        },
      },
      openInViewer: () => ({ closed: false, close() { this.closed = true; } }),
    },
  });
  plugin.alert = () => {};
  const session = await plugin.connect(null);
  await session.query({ token: "synthetic-token" }, true);
  session.close();
  session.close();
  assert.equal(disposed, 1);
});
