# Wikipedia to Zotero

Import your Wikipedia **Saved** reading lists into Zotero, with the original
saved timestamps and list names as tags.

- Windows, Linux, and macOS; Python 3.11 or newer.
- Zotero **10 or newer**, running locally. No Zotero password or cloud API key needed.
- Python standard library only; no runtime dependencies.
- Dry-run planning, pre-change backups, duplicate avoidance, and read-back verification.

## What is imported

Each distinct article becomes an **Encyclopedia Article** with its title,
Wikipedia URL, encyclopedia name, and language. This is a metadata import, not
an offline article/snapshot downloader.

- Every reading-list name becomes a tag, including the API's literal `default`
  name for the default list.
- Zotero's **Date Added** is set to the article's earliest saved timestamp in
  UTC. The article publication-date field is not repurposed.
- **Extra** retains the earliest timestamp and each individual list's saved
  timestamp, so articles saved into several lists lose no timing information.
- Existing bibliography items are matched by Wikipedia URL. Existing fields,
  tags, collections, and attachments are preserved; Date Added is intentionally
  updated and tags/provenance are appended.
- Attachments and notes are never mistaken for bibliography items. Existing
  duplicate bibliography records are updated but not deleted or merged.
- Mobile URLs, URL escaping, spaces/underscores, and URL fragments are
  normalized. Different languages remain distinct. Redirect aliases, historical
  `oldid` revisions, and renamed articles are not resolved through Wikipedia;
  URL matching is not a full content-equivalence check.

## Install

Clone or download this repository. These commands work from its directory:

```console
python -m pip install .
python -m wikipedia_to_zotero --help
```

On Windows, use `py -3` instead of `python` if that is your Python launcher.
On Linux/macOS, use `python3` if needed. A virtual environment is recommended.
You can also run `python wikipedia_to_zotero.py` directly without installing.

In Zotero, enable **Settings -> Advanced -> Allow other applications on this
computer to communicate with Zotero**. Keep Zotero running throughout the import.

## Option 1: interactive Wikipedia login

```console
python -m wikipedia_to_zotero --dry-run
python -m wikipedia_to_zotero
```

Enter your username and password when prompted. Email/authenticator verification
is prompted when supported by Wikipedia's API. Browser-only challenges require
Option 2 below. Cookies, passwords, and Zotero write keys stay in memory.

For unattended username/password input, explicitly set `WIKIPEDIA_USERNAME` and
`WIKIPEDIA_PASSWORD` in your process environment. The tool **does not** read or
execute shell profiles, credential files, or `.env` files. Prefer interactive
password prompts over shell history. `--yes` skips the CLI confirmation only;
it does not bypass Wikipedia verification or Zotero's permission dialog.

## Option 2: export from an already signed-in browser

1. Sign in and open your own [Wikipedia Saved page](https://en.wikipedia.org/wiki/Special:ReadingLists).
2. Open browser Developer Tools -> Console.
3. Read [export_saved_lists.js](export_saved_lists.js), then paste its contents
   into the console and run it. Never paste browser-console scripts you have not
   reviewed. This script only reads Wikipedia and downloads a local JSON file;
   it sends no saved items to another server.
4. Import the downloaded file:

```console
python -m wikipedia_to_zotero --source "path/to/wikipedia-saved-snapshot.json" --dry-run
python -m wikipedia_to_zotero --source "path/to/wikipedia-saved-snapshot.json"
```

Paths with spaces must be quoted. On Windows, normal Windows paths work too.

The source JSON contains `lists` (each with `id`, `name`, and `size`) and `entries`
(each with `id`, `listId`, `project`, `title`, and timezone-aware `created`).
Incomplete list counts and duplicate entry IDs are rejected before writes.
Saved-list synchronization must already be enabled; on-device-only items are
not available through Wikipedia's account API.

## Safety, progress, and resuming

The CLI prints the full plan before changing Zotero. Approve the local permission
dialog in Zotero; **Always Allow** avoids repeated prompts for 50-item batches.
You can clear remembered permissions in Zotero's Advanced settings afterward.
The API binds requests to the current Zotero instance and uses item versions
to reject conflicting edits.

The first batch is read back before proceeding, and every affected record is
verified at completion for URL, tags, Date Added, and per-folder timestamps.
Bulk imports can take time: Zotero saves each item through its normal database
and notification pipeline. Selecting a small existing collection instead of
the full library can reduce redraw work. Do not close Zotero until verification
has finished.

If interrupted or a batch partly fails, rerun the **same source** command. The
tool re-reads the library and matches items already saved. New items have stable
keys to avoid creating duplicates after an ambiguous network timeout. Collisions
with unrelated keys stop the import rather than overwriting records.
Source data should remain stable throughout an import; concurrent metadata edits
can cause a version conflict, which requires a rerun.

Before writes, a timestamped source snapshot and backup of matched bibliography
records are saved outside the repository:

| Platform | Default state directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\wikipedia-to-zotero` |
| macOS | `~/Library/Application Support/wikipedia-to-zotero` |
| Linux | `$XDG_STATE_HOME/wikipedia-to-zotero`, or `~/.local/state/wikipedia-to-zotero` |

Override with `--state-dir "path/to/private-directory"`. Treat snapshots and backups
as private browsing-history data. Unix files are created with owner-only
permissions; Windows uses the directory's existing access controls, so choose a
private user directory. Backups are JSON records for inspection/recovery, not an
automatic rollback command. No changes are made for `--dry-run`.

Local changes sync to your Zotero account through Zotero's normal sync. This tool
verifies the local database, **not cloud-sync completion**. Keep the local API
bound to localhost; never expose port 23119 to a network.

## Development

```console
python -m unittest discover -s tests -v
python -m pip install ruff pyright
ruff check .
pyright wikipedia_to_zotero.py
```

GitHub Actions runs the tests on Windows, Linux, and macOS with Python 3.11 and
3.14. Tests use synthetic data and fake clients: they do not log into accounts
or mutate a real library. The browser export is exercised with a mocked browser
environment on Node.js.

Before publishing, scan the public candidate and committed history with
GitGuardian's `ggshield`:

```console
ggshield secret scan path --recursive --yes --use-gitignore .
ggshield secret scan repo .
```

GitGuardian scanning uses its hosted service. Scan public source only, never
personal exports, backups, credentials, or unrelated working directories.

## License

[MIT](LICENSE).
