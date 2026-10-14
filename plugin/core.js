/* Pure data operations shared by the Zotero plugin and its Node.js tests. */
var WikipediaZoteroCore = (() => {
  "use strict";
  const CSV_FIELDS = ["title", "url", "date_added", "tags", "extra", "saved_lists"];

  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  function timestamp(value) {
    requireValue(typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
    "Saved timestamps must be ISO datetimes with a timezone.");
    const date = new Date(value);
    requireValue(Number.isFinite(date.getTime()), "Invalid saved timestamp.");
    const day = value.slice(0, 10);
    requireValue(new Date(day + "T00:00:00Z").toISOString().slice(0, 10) === day
      && Number(value.slice(11, 13)) < 24, "Invalid saved timestamp.");
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function identity(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(".m.wikipedia.org", ".wikipedia.org");
      if (!["https:", "http:"].includes(url.protocol) || !host.endsWith(".wikipedia.org")
          || url.port || url.username || url.password) return null;
      let title;
      if (url.pathname.startsWith("/wiki/")) title = decodeURIComponent(url.pathname.slice(6));
      else if (url.pathname === "/w/index.php") title = url.searchParams.get("title");
      if (!title) return null;
      return JSON.stringify([host, title.replaceAll("_", " ").normalize("NFC")]);
    } catch (error) {
      if (error instanceof TypeError || error instanceof URIError) return null;
      throw error;
    }
  }

  function articleURL(project, title) {
    return project.replace(/\/$/, "") + "/wiki/" + encodeURIComponent(title.replaceAll(" ", "_"));
  }

  function articles(snapshot) {
    requireValue(snapshot && Array.isArray(snapshot.lists) && Array.isArray(snapshot.entries),
      "Source must contain lists and entries arrays.");
    const lists = new Map();
    for (const list of snapshot.lists) {
      requireValue(Number.isInteger(list.id) && !lists.has(list.id), "Invalid or duplicate list ID.");
      requireValue(typeof list.name === "string" && list.name.trim()
        && !/[\r\n]/.test(list.name), "Invalid reading-list name.");
      requireValue(Number.isInteger(list.size) && list.size >= 0, "Invalid reading-list size.");
      lists.set(list.id, list);
    }
    const ids = new Set();
    const counts = new Map();
    const grouped = new Map();
    for (const entry of snapshot.entries) {
      requireValue(Number.isInteger(entry.id) && !ids.has(entry.id), "Invalid or duplicate entry ID.");
      ids.add(entry.id);
      requireValue(lists.has(entry.listId), "Entry references an unknown reading list.");
      requireValue(typeof entry.title === "string" && entry.title.trim(), "Invalid article title.");
      requireValue(typeof entry.project === "string"
        && /^https:\/\/[a-z0-9-]+\.wikipedia\.org\/?$/.test(entry.project),
      "Unsupported Wikipedia project.");
      const url = articleURL(entry.project, entry.title);
      const canonical = identity(url);
      requireValue(canonical, "Invalid Wikipedia article URL.");
      const saved = timestamp(entry.created);
      counts.set(entry.listId, (counts.get(entry.listId) || 0) + 1);
      if (!grouped.has(canonical)) {
        grouped.set(canonical, { canonical, title: entry.title, url, memberships: [] });
      }
      const memberships = grouped.get(canonical).memberships;
      requireValue(!memberships.some(item => item.listId === entry.listId),
        "Duplicate article membership in the same list.");
      memberships.push({ listId: entry.listId, name: lists.get(entry.listId).name, created: saved });
    }
    for (const list of lists.values()) {
      requireValue((counts.get(list.id) || 0) === list.size,
        "Incomplete export: reading-list size does not match. Retry before importing.");
    }
    return [...grouped.values()].map(article => {
      article.memberships.sort((a, b) => a.listId - b.listId);
      const saved = article.memberships.map(item => item.created).sort()[0];
      const tags = [...new Set(article.memberships.map(item => item.name))].sort();
      return { ...article, saved, tags, provenance: [
        `Wikipedia saved: ${saved}`,
        ...article.memberships.map(item => `Wikipedia list saved: ${item.name} | ${item.created}`),
      ] };
    });
  }

  function plan(snapshot, existing) {
    const byURL = new Map();
    for (const item of existing) {
      if (["attachment", "note", "annotation"].includes(item.itemType)) continue;
      const canonical = identity(item.url);
      if (!canonical) continue;
      if (!byURL.has(canonical)) byURL.set(canonical, []);
      byURL.get(canonical).push(item);
    }
    return articles(snapshot).flatMap(article => {
      const matches = byURL.get(article.canonical) || [];
      if (!matches.length) {
        return [{ article, operation: "create", before: null, data: {
          itemType: "encyclopediaArticle", title: article.title, url: article.url,
          encyclopediaTitle: "Wikipedia", language: JSON.parse(article.canonical)[0].split(".")[0],
          creators: [], tags: article.tags.map(tag => ({ tag })),
          collections: [], relations: {}, dateAdded: article.saved,
          accessDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          extra: article.provenance.join("\n"),
        } }];
      }
      return matches.map(before => {
        const tags = JSON.parse(JSON.stringify(before.tags || []));
        for (const tag of article.tags) {
          if (!tags.some(item => item.tag === tag)) tags.push({ tag });
        }
        let extra = before.extra || "";
        const lines = extra.split(/\r?\n/);
        const missing = article.provenance.filter(line => !lines.includes(line));
        if (missing.length) extra += (extra && !extra.endsWith("\n") ? "\n" : "") + missing.join("\n");
        const data = { ...before, dateAdded: article.saved, tags, extra };
        const changed = before.dateAdded !== data.dateAdded
          || JSON.stringify(before.tags || []) !== JSON.stringify(tags) || before.extra !== data.extra;
        return { article, operation: changed ? "update" : "unchanged", before, data };
      });
    });
  }

  function verify(planned, stored) {
    const byKey = new Map(stored.map(item => [item.key, item]));
    for (const item of planned) {
      const actual = byKey.get(item.data.key);
      const article = item.article;
      requireValue(actual && identity(actual.url) === article.canonical
        && actual.dateAdded === article.saved
        && article.tags.every(tag => actual.tags?.some(item => item.tag === tag))
        && article.provenance.every(line => (actual.extra || "").split(/\r?\n/).includes(line)),
      `Read-back verification failed for item ${item.data.key || "(missing key)"}.`);
      if (item.before) {
        requireValue((item.before.tags || []).every(tag => actual.tags?.some(
          saved => saved.tag === tag.tag && (saved.type || 0) === (tag.type || 0))),
        "An existing tag changed unexpectedly.");
        requireValue((actual.extra || "").startsWith(item.before.extra || ""),
          "Existing Extra text changed unexpectedly.");
        for (const [field, value] of Object.entries(item.before)) {
          if (["version", "dateAdded", "dateModified", "tags", "extra"].includes(field)) continue;
          requireValue(JSON.stringify(actual[field]) === JSON.stringify(value),
            `Existing metadata changed unexpectedly: ${field}.`);
        }
      }
    }
    return planned.length;
  }

  function toCSV(snapshot) {
    requireValue(new Set(snapshot.lists.map(list => list.name)).size === snapshot.lists.length,
      "CSV export requires unique reading-list names.");
    const rows = articles(snapshot).map(article => [
      article.title, article.url, article.saved, JSON.stringify(article.tags),
      article.provenance.join("\n"),
      JSON.stringify(article.memberships.map(({ name, created }) => ({ name, created }))),
    ]);
    const cell = value => '"' + value.replaceAll('"', '""') + '"';
    return "\uFEFF" + [CSV_FIELDS, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  function csvRows(text) {
    const rows = [];
    let row = [], cell = "", quoted = false, endedQuote = false;
    text = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') { quoted = false; endedQuote = true; }
        else cell += ch;
      } else if (ch === '"' && cell === "" && !endedQuote) {
        quoted = true;
      } else if (ch === "," || ch === "\n" || ch === "\r") {
        row.push(cell); cell = ""; endedQuote = false;
        if (ch !== ",") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          rows.push(row); row = [];
        }
      } else {
        requireValue(!endedQuote && ch !== '"', "Malformed CSV quoting.");
        cell += ch;
      }
    }
    requireValue(!quoted, "Truncated CSV quoted field.");
    if (cell || row.length || endedQuote) { row.push(cell); rows.push(row); }
    return rows;
  }

  function fromCSV(text) {
    const rows = csvRows(text);
    requireValue(JSON.stringify(rows.shift()) === JSON.stringify(CSV_FIELDS), "Unexpected CSV columns.");
    const snapshot = { lists: [], entries: [] };
    const names = new Map(), seen = new Set();
    for (const row of rows) {
      requireValue(row.length === CSV_FIELDS.length, "CSV row has missing or extra fields.");
      const [title, url, saved, tagText, extra, savedText] = row;
      const canonical = identity(url);
      requireValue(canonical && !seen.has(canonical), "Invalid or duplicate CSV article URL.");
      seen.add(canonical);
      const [host, canonicalTitle] = JSON.parse(canonical);
      requireValue(title.replaceAll("_", " ").normalize("NFC") === canonicalTitle,
        "CSV title does not match its URL.");
      const tags = JSON.parse(tagText), memberships = JSON.parse(savedText);
      requireValue(Array.isArray(tags) && tags.every(tag => typeof tag === "string")
        && Array.isArray(memberships) && memberships.length, "Invalid CSV memberships or tags.");
      const listNames = memberships.map(item => {
        requireValue(item && typeof item.name === "string" && item.name.trim()
          && !/[\r\n]/.test(item.name), "Invalid CSV list name.");
        return item.name;
      });
      requireValue(new Set(listNames).size === listNames.length
        && JSON.stringify([...tags].sort()) === JSON.stringify([...listNames].sort()),
      "CSV tags do not match saved-list names.");
      const times = memberships.map(item => timestamp(item.created));
      const earliest = [...times].sort()[0];
      requireValue(timestamp(saved) === earliest, "CSV Date Added does not match saved timestamps.");
      const expected = [`Wikipedia saved: ${earliest}`, ...memberships.map(
        (item, index) => `Wikipedia list saved: ${item.name} | ${times[index]}`)];
      requireValue(JSON.stringify([...new Set(extra.split(/\r?\n/))].sort())
        === JSON.stringify([...new Set(expected)].sort()), "CSV provenance does not match timestamps.");
      for (const [index, membership] of memberships.entries()) {
        if (!names.has(membership.name)) {
          const list = { id: names.size + 1, name: membership.name, size: 0 };
          names.set(membership.name, list); snapshot.lists.push(list);
        }
        const list = names.get(membership.name);
        list.size++;
        snapshot.entries.push({ id: snapshot.entries.length + 1, listId: list.id,
          project: "https://" + host, title, created: times[index] });
      }
    }
    articles(snapshot);
    return snapshot;
  }

  function fingerprint(account, snapshot) {
    articles(snapshot);
    const lists = snapshot.lists.map(list => [
      list.id, list.name, list.description || "", list.size, list.created || "", list.updated || "",
    ]).sort((a, b) => a[0] - b[0]);
    const entries = snapshot.entries.map(entry => [
      entry.id, entry.listId, entry.project, entry.title, entry.created, entry.updated || "",
    ]).sort((a, b) => a[0] - b[0]);
    return JSON.stringify({ account, lists, entries });
  }

  async function maybeDelete({ account, snapshot, backupVerified, importVerified,
    readCurrent, confirm, teardown, isDisabled }) {
    requireValue(backupVerified && importVerified,
      "Deletion is blocked until the backup and complete Zotero import are verified.");
    if (!await confirm(account)) return { deleted: false };
    const current = await readCurrent();
    requireValue(fingerprint(current.account, current.snapshot) === fingerprint(account, snapshot),
      "Wikipedia account or saved lists changed. Nothing was deleted; import again.");
    await teardown();
    requireValue(await isDisabled(), "Deletion could not be verified. Check Wikipedia before retrying.");
    return { deleted: true };
  }

  return { CSV_FIELDS, timestamp, identity, articles, plan, verify, toCSV, fromCSV,
    fingerprint, maybeDelete };
})();

if (typeof module !== "undefined") module.exports = WikipediaZoteroCore;
