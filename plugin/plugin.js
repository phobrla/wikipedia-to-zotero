/* global Zotero, Services, IOUtils, PathUtils, ChromeUtils, Components */
var WikipediaZoteroPlugin = {
  core: null,
  busy: false,
  active: false,
  session: null,
  menuID: "wikipedia-to-zotero-menu",

  init(core) { this.core = core; this.active = true; },

  addToWindow(window) {
    const document = window.document;
    if (document.getElementById(this.menuID)) return;
    const popup = document.getElementById("menu_ToolsPopup");
    if (!popup) throw new Error("Wikipedia to Zotero: Tools menu not found.");
    const menu = document.createXULElement("menu");
    menu.id = this.menuID;
    menu.setAttribute("label", "Wikipedia Saved");
    const entries = document.createXULElement("menupopup");
    for (const [label, action] of [
      ["Import from Wikipedia...", "import"],
      ["Import saved CSV or JSON...", "file"],
      ["Export Wikipedia Saved to CSV...", "export"],
    ]) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => this.run(window, action));
      entries.appendChild(item);
    }
    menu.appendChild(entries);
    popup.appendChild(menu);
  },

  removeFromWindow(window) { window.document.getElementById(this.menuID)?.remove(); },

  shutdown() {
    this.active = false;
    this.session?.close();
    for (const window of Zotero.getMainWindows()) this.removeFromWindow(window);
  },

  checkActive() {
    if (!this.active) throw new Error("Plugin was disabled; operation cancelled.");
  },

  alert(window, message) {
    Services.prompt.alert(window, "Wikipedia to Zotero", message);
  },

  choose(window, title, message, first, second) {
    const p = Services.prompt;
    return p.confirmEx(window, title, message,
      p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING
      + p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_0_DEFAULT,
      first, second, null, null, {}) === 1;
  },

  async pickFile(window, save) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(window, save ? "Export private Wikipedia CSV" : "Import Wikipedia saved data",
      save ? picker.modeSave : picker.modeOpen);
    picker.appendFilter(save ? "CSV files" : "CSV or JSON files", save ? "*.csv" : "*.csv; *.json");
    if (save) { picker.defaultString = "wikipedia-saved.csv"; picker.defaultExtension = "csv"; }
    const result = await picker.show();
    if (result === picker.returnCancel) return null;
    if (save && result === picker.returnReplace) {
      throw new Error("Choose a new filename. Existing backups are never overwritten.");
    }
    return picker.file;
  },

  async writePrivate(path, text) {
    const file = Zotero.File.pathToFile(path);
    file.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o600);
    await IOUtils.writeUTF8(path, text, { mode: "overwrite", flush: true });
    const actual = await IOUtils.read(path);
    const expected = new TextEncoder().encode(text);
    if (actual.length !== expected.length
        || actual.some((value, index) => value !== expected[index])) {
      throw new Error("Private backup read-back failed; deletion is blocked.");
    }
  },

  async connect(window) {
    const context = Zotero.HTTP.newCookieContext();
    let viewer;
    const session = {
      account: null,
      closed: false,
      close() {
        if (this.closed) return;
        this.closed = true;
        if (viewer && !viewer.closed) viewer.close();
        context.dispose();
      },
      async query(parameters, post = false) {
        if (this.closed) throw new Error("Wikipedia login session was closed.");
        const params = new URLSearchParams({ format: "json", formatversion: "2", ...parameters });
        let response;
        try {
          response = await Zotero.HTTP.request(post ? "POST" : "GET",
            "https://en.wikipedia.org/w/api.php" + (post ? "" : "?" + params), {
              ...(post ? { body: params.toString(),
                headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
              userContextId: context.id, responseType: "json", timeout: 60000,
              errorDelayMax: 0, logBodyLength: 0,
            });
        } catch {
          throw new Error("Wikipedia request failed. Check your connection and retry. "
            + "Partial imports can be resumed; no automatic deletion was attempted.");
        }
        const json = response.response;
        if (json.error) {
          const error = new Error("Wikipedia API: " + json.error.code);
          error.code = json.error.code;
          throw error;
        }
        return json;
      },
    };
    this.session = session;
    this.alert(window, "Sign in to Wikipedia in the window that opens, including any email/2FA "
      + "challenge. The plugin never sees or stores your password. "
      + "Close that window to cancel. Its isolated login cookies are removed when finished.");
    viewer = Zotero.openInViewer(
      "https://en.wikipedia.org/w/index.php?title=Special:UserLogin&returnto=Special:ReadingLists",
      { userContextId: context.id }
    );
    try {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        this.checkActive();
        if (viewer.closed) throw new Error("Wikipedia sign-in cancelled.");
        const result = await session.query({ action: "query", meta: "userinfo" });
        const user = result.query.userinfo;
        if (user.name && !user.anon && user.id > 0) {
          session.account = user.name;
          viewer.close();
          return session;
        }
        await Zotero.Promise.delay(1500);
      }
      throw new Error("Wikipedia sign-in timed out. Run the import again to retry.");
    } catch (error) {
      session.close();
      throw error;
    }
  },

  async readSnapshot(session, status) {
    const lists = [], entries = [];
    let continuation = {};
    do {
      this.checkActive();
      const result = await session.query({ action: "query", meta: "readinglists",
        rllimit: "12", ...continuation });
      lists.push(...result.query.readinglists);
      continuation = result.continue;
    } while (continuation);
    for (let start = 0; start < lists.length; start += 100) {
      continuation = {};
      do {
        this.checkActive();
        const result = await session.query({ action: "query", list: "readinglistentries",
          rlelists: lists.slice(start, start + 100).map(list => list.id).join("|"),
          rlelimit: "100", ...continuation });
        entries.push(...result.query.readinglistentries);
        continuation = result.continue;
        status?.(`Downloaded ${entries.length} saved-list entries`);
      } while (continuation);
    }
    const snapshot = { lists, entries };
    this.core.articles(snapshot);
    return snapshot;
  },

  async readItems() {
    const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false);
    return items.filter(item => item.isRegularItem()).map(item => item.toJSON());
  },

  async saveBatch(batch) {
    await Zotero.DB.executeTransaction(async () => {
      for (const planned of batch) {
        this.checkActive();
        let item;
        if (planned.before) {
          item = await Zotero.Items.getByLibraryAndKeyAsync(
            Zotero.Libraries.userLibraryID, planned.before.key);
          if (!item || item.deleted || JSON.stringify(item.toJSON()) !== JSON.stringify(planned.before)) {
            throw new Error("An existing Zotero item changed during import. Nothing in this batch "
              + "was saved. Run the import again to preserve your edits.");
          }
        } else {
          item = new Zotero.Item("encyclopediaArticle");
          item.libraryID = Zotero.Libraries.userLibraryID;
        }
        item.fromJSON(planned.data);
        await item.save();
        planned.data.key = item.key;
      }
    });
  },

  async importSnapshot(window, snapshot, session, status) {
    const core = this.core;
    const planned = core.plan(snapshot, await this.readItems());
    const counts = { create: 0, update: 0, unchanged: 0 };
    for (const item of planned) counts[item.operation]++;
    const total = core.articles(snapshot).length;
    if (!total) {
      this.alert(window, "There are no saved articles to import. Nothing was deleted.");
      return;
    }
    if (!this.choose(window, "Import Wikipedia Saved?",
      `${snapshot.lists.length} lists, ${snapshot.entries.length} memberships, ${total} articles.\n\n`
      + `Create: ${counts.create}; update: ${counts.update}; unchanged: ${counts.unchanged}.\n\n`
      + "Destination: My Library. All folder names become tags. Date Added becomes the earliest "
      + "saved timestamp. Each folder's timestamp is retained in Extra. Existing fields, "
      + "collections, and attachments are preserved. Duplicate records are not merged.\n\n"
      + "Private JSON/CSV backups are saved inside your Zotero data directory. "
      + "Wikipedia data is only deleted if you explicitly approve a separate prompt afterward.",
      "Cancel", "Import")) return;
    this.checkActive();
    const directory = PathUtils.join(Zotero.DataDirectory.dir, "wikipedia-to-zotero");
    await IOUtils.makeDirectory(directory, { ignoreExisting: true, permissions: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      + "-" + Zotero.Utilities.randomString(6);
    const base = PathUtils.join(directory, stamp);
    await this.writePrivate(base + "-snapshot.json", JSON.stringify(snapshot, null, 2));
    await this.writePrivate(base + "-backup.json",
      JSON.stringify(planned.filter(item => item.before).map(item => item.before), null, 2));
    const csv = core.toCSV(snapshot);
    await this.writePrivate(base + "-saved.csv", csv);
    // Reconstruct the CSV before allowing any destructive follow-up.
    const restored = core.articles(core.fromCSV(await IOUtils.readUTF8(base + "-saved.csv")));
    const signature = articles => articles.map(article => JSON.stringify([
      article.canonical, article.saved, article.tags,
      [...article.provenance].sort(),
    ])).sort().join("\n");
    if (signature(restored) !== signature(core.articles(snapshot))) {
      throw new Error("CSV backup validation failed. Nothing was deleted.");
    }
    const writes = planned.filter(item => item.operation !== "unchanged");
    for (let start = 0; start < writes.length; start += 50) {
      this.checkActive();
      const batch = writes.slice(start, start + 50);
      await this.saveBatch(batch);
      core.verify(batch, await this.readItems());
      status(`Saved and verified ${Math.min(start + 50, writes.length)}/${writes.length} changes`);
    }
    core.verify(planned, await this.readItems());
    await this.writePrivate(base + "-verification.json", JSON.stringify({
      account: session?.account || null, articles: total, memberships: snapshot.entries.length,
      counts, verified: planned.length, verifiedAt: new Date().toISOString(),
    }, null, 2));
    this.checkActive();
    if (!session) {
      this.alert(window, `Verified ${total} articles. Backups: ${directory}\n\n`
        + "File imports never delete Wikipedia data. Use a live Wikipedia import to request deletion.");
      return;
    }
    const outcome = await core.maybeDelete({
      account: session.account, snapshot, backupVerified: true, importVerified: true,
      confirm: async account => {
        this.checkActive();
        if (!this.choose(window, "Keep or delete Wikipedia originals?",
          `Import verified: ${total} articles. Private backup: ${base}-saved.csv\n\n`
          + `Account: ${account}\n\nKEEP is recommended and is the default.\n\n`
          + "Delete removes ALL Wikipedia saved lists and entries for this account across languages, "
          + "including the default list and custom folders. Zotero and your backups are untouched. "
          + "There is no user-facing undo guarantee. This does not hide the Saved interface.\n\n"
          + "The plugin will recheck that the account and all saved lists are unchanged before deletion.",
          "Keep originals", "Delete ALL originals...")) return false;
        const typed = { value: "" };
        return Services.prompt.prompt(window, "Confirm account-wide deletion",
          `Type the Wikipedia username ${account} exactly to delete ALL its saved lists:`,
          typed, null, {}) && typed.value === account;
      },
      readCurrent: async () => {
        this.checkActive();
        const user = (await session.query({ action: "query", meta: "userinfo" })).query.userinfo;
        return { account: user.name, snapshot: await this.readSnapshot(session, status) };
      },
      teardown: async () => {
        this.checkActive();
        const result = await session.query({ action: "query", meta: "tokens", type: "csrf" });
        await session.query({ action: "readinglists", command: "teardown",
          token: result.query.tokens.csrftoken }, true);
      },
      isDisabled: async () => {
        try {
          await session.query({ action: "query", meta: "readinglists", rllimit: "12" });
          return false;
        } catch (error) {
          if (error.code === "readinglists-db-error-not-set-up") return true;
          throw error;
        }
      },
    });
    this.alert(window, `Verified ${total} imported articles.\n\n`
      + (outcome.deleted ? "All Wikipedia saved lists were deleted and deletion was verified."
        : "Wikipedia originals were kept.")
      + `\n\nPrivate backups: ${directory}\nZotero handles cloud synchronization separately.`);
  },

  async run(window, action) {
    if (this.busy) {
      this.alert(window, "Another Wikipedia operation is running. Finish or cancel it first.");
      return;
    }
    this.busy = true;
    let session, progress;
    try {
      this.checkActive();
      let snapshot;
      if (action === "file") {
        const path = await this.pickFile(window, false);
        if (!path) return;
        const text = await IOUtils.readUTF8(path);
        snapshot = path.toLowerCase().endsWith(".csv") ? this.core.fromCSV(text) : JSON.parse(text);
        this.core.articles(snapshot);
      } else {
        session = await this.connect(window);
      }
      progress = new Zotero.ProgressWindow({ window, closeOnClick: false });
      progress.changeHeadline("Wikipedia Saved");
      const line = new progress.ItemProgress("", "Preparing...");
      progress.show();
      const status = message => { line.setText(message); line.setProgress(50); };
      if (session) {
        try {
          snapshot = await this.readSnapshot(session, status);
        } catch (error) {
          if (error.code !== "readinglists-db-error-not-set-up") throw error;
          this.alert(window, "This Wikipedia account has no saved lists set up. "
            + "Nothing was imported or deleted.");
          return;
        }
      }
      if (action === "export") {
        const path = await this.pickFile(window, true);
        if (!path) return;
        await this.writePrivate(path, this.core.toCSV(snapshot));
        this.alert(window, `Exported ${this.core.articles(snapshot).length} articles to:\n${path}\n\n`
          + "Zotero and Wikipedia were not modified.");
      } else {
        await this.importSnapshot(window, snapshot, session, status);
      }
      line.setProgress(100);
    } catch (error) {
      // Do not log response bodies, tokens, or account browsing data.
      this.alert(window, "Operation stopped: " + error.message
        + "\n\nIf some items were imported, run again to resume without duplicates. "
        + "If deletion was requested but its verification failed, check Wikipedia before retrying.");
    } finally {
      progress?.close();
      session?.close();
      this.session?.close();
      this.session = null;
      this.busy = false;
    }
  },
};
