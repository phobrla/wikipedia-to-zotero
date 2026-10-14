// Run in the browser console on your own signed-in Wikipedia Saved page.
// Reading-list data stays in the browser until downloaded to your computer.
(async () => {
  "use strict";
  if (location.protocol !== "https:" || location.hostname !== "en.wikipedia.org") {
    throw new Error("Run this on https://en.wikipedia.org while signed in.");
  }
  const query = async (parameters) => {
    const response = await fetch("/w/api.php?" + new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      ...parameters,
    }));
    if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`Wikipedia API: ${result.error.code}`);
    return result;
  };
  const paginate = async (parameters, field) => {
    const items = [];
    let continuation = {};
    do {
      const result = await query({ ...parameters, ...continuation });
      items.push(...(result.query?.[field] || []));
      continuation = result.continue;
    } while (continuation);
    return items;
  };
  const lists = await paginate({ meta: "readinglists", rllimit: "12" }, "readinglists");
  const entries = [];
  for (let start = 0; start < lists.length; start += 100) {
    const identifiers = lists.slice(start, start + 100).map((list) => list.id).join("|");
    entries.push(...await paginate({
      list: "readinglistentries",
      rlelists: identifiers,
      rlelimit: "100",
    }, "readinglistentries"));
    console.info(`Exported ${entries.length} saved-list entries`);
  }
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.listId, (counts.get(entry.listId) || 0) + 1);
  }
  if (lists.some((list) => (counts.get(list.id) || 0) !== list.size)) {
    throw new Error("List sizes changed during export. Run again to get a complete export.");
  }
  const blob = new Blob([JSON.stringify({ lists, entries }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wikipedia-saved-snapshot.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  console.info(`Downloaded ${entries.length} entries from ${lists.length} reading lists.`);
})().catch((error) => console.error("Export failed:", error));
