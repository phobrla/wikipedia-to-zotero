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

### Zotero plugin (no Python required)

Download the `.xpi` from the [latest release](https://github.com/phobrla/wikipedia-to-zotero/releases/latest).
Requires **Zotero 10.0.x** on Windows, Linux, or macOS.

1. In Zotero, open **Tools -> Plugins**.
2. Use the gear menu -> **Install Plugin From File...**, select the `.xpi`, and
   accept Zotero's installation prompt.
3. Open **Tools -> Wikipedia Saved**:
   - **Import from Wikipedia...** signs in and imports the account's saved lists.
   - **Import saved CSV or JSON...** imports an existing export without logging in.
   - **Export Wikipedia Saved to CSV...** creates a private CSV without importing
     or deleting anything.

Sign in inside Zotero's browser window, including any email verification or 2FA.
The plugin does not receive or store your password. Login uses a separate cookie
context; those cookies are removed at the end of the operation. Closing the login
window cancels. This session is separate from your usual browser's login.
If embedded sign-in is blocked by Wikipedia, use the browser export described
below and the plugin's file-import command.

Imports always target **My Library**, not a selected group library. The plugin
shows counts and asks before starting. It uses Zotero's native database API
(no local HTTP write authorization needed). It saves verified, private JSON
source/metadata backups, a CSV, and a completion report under
`wikipedia-to-zotero` inside the **Zotero data directory**. On Unix files are
owner-readable only; on Windows keep the data directory private using Windows
access controls. Existing files are never overwritten. Imports are saved in
50-item transactions and verified after each batch and at completion. If the
plugin is disabled or an error occurs, the operation stops; rerun to resume.

**After a successful live import**, the plugin offers:

- **Keep originals** (default): nothing is deleted on Wikipedia.
- **Delete ALL originals...**: requires a second prompt in which you type the
  signed-in Wikipedia username exactly.

Deletion is **account-wide across Wikipedia languages**, including the default
list and all custom folders. It does not hide Wikipedia's Saved/bookmark controls.
There is no user-facing undo guarantee. Immediately before deletion, the plugin
rechecks the account, every list, and every entry against the verified import.
Changed/new data blocks deletion: import again instead. It uses Wikipedia's
official `readinglists` `teardown` operation and verifies that lists are no longer
set up afterward. Do not save/edit Wikipedia lists while an import or deletion
is running: Wikipedia does not offer an atomic "delete only if unchanged" API.
Avoid using another client to save items between the final check and deletion.

File imports never offer deletion, since there is no authenticated live account
to compare. Failed/incomplete imports, failed backups, and CSV-only exports also
never offer deletion. Your Zotero items and local backups are not deleted.
The plugin never automatically deletes data or changes Wikipedia preferences.

The plugin and CLI use the same CSV format, so exports can be re-imported by
either tool. Review CSVs in text-import mode rather than enabling spreadsheet
formulas or external links. Empty folders are retained in JSON but not CSV.
Reading-list names must be unique for CSV export and for the plugin's automatic
CSV backup; ambiguous names stop the import rather than losing information.

### Python CLI

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

## Private CSV backup and bulk re-import

Export a reusable CSV **without contacting or modifying Zotero**:

```console
python -m wikipedia_to_zotero --source "path/to/wikipedia-saved-snapshot.json" --export-csv "path/to/private/wikipedia-saved.csv"
```

Without `--source`, the same flag logs into Wikipedia interactively and exports
your current Saved items. The destination must not already exist; exports never
overwrite an existing file. `--export-csv` is an export-only operation and cannot
be combined with `--dry-run`.

To bulk re-import later, use this tool:

```console
python -m wikipedia_to_zotero --source-csv "path/to/private/wikipedia-saved.csv" --dry-run
python -m wikipedia_to_zotero --source-csv "path/to/private/wikipedia-saved.csv"
```

**This is the tool's round-trip CSV format, not a native Zotero CSV import
format.** Zotero's desktop importer does not directly import this CSV. The
`--source-csv` flag applies the same duplicate avoidance, backups, permission
checks, and read-back verification as JSON imports.

The UTF-8 CSV (with a BOM for spreadsheet compatibility) contains one row per
distinct article and these columns:

| Column | Meaning |
| --- | --- |
| `title` | Original Wikipedia article title |
| `url` | Canonical Wikipedia article URL |
| `date_added` | Earliest saved timestamp, in UTC |
| `tags` | JSON array of all folder/list names |
| `extra` | Earliest and per-folder timestamps as provenance text |
| `saved_lists` | JSON array of objects with `name` and `created` for each folder |

CSV quoting preserves commas, quotes, newlines, and non-ASCII text. List names
must be unique. Empty folders do not have article rows and are not retained;
keep the original JSON if you need the complete list inventory. Re-import
validates the redundant tags, Date Added, and provenance against `saved_lists`
and rejects inconsistent or duplicate records before modifying Zotero.

Store the CSV **outside your repository** in a private directory. All `*.csv`
files are gitignored as an additional safeguard; no exports or personal data
belong in the public repository. Exported cells retain original text, so use a
spreadsheet's text-import mode rather than enabling formulas or external links
when inspecting untrusted article titles. Prefer the unchanged CSV for re-import.

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
node --test tests/test_plugin.cjs
python scripts/build_plugin.py
```

The plugin source is in [plugin/](plugin/). The build script packages an explicit
allowlist of source files and the license into `dist/wikipedia-to-zotero-0.2.0.xpi`;
it does not copy exports, credentials, or other local data. Node tests cover CSV
compatibility with Python, metadata preservation, idempotence, bootstrap lifecycle,
and deletion safeguards. Set `PYTHON` to a specific Python executable for Node's
CSV interoperability test if `python` is not on your PATH.
For plugin releases, keep the version/compatibility in
[manifest.json](plugin/manifest.json) and [updates.json](plugin/updates.json) in
sync, then attach the built XPI to the matching GitHub release. Zotero requires
the manifest's update URL; it checks the public update feed for newer releases.

GitHub Actions runs the tests on Windows, Linux, and macOS with Python 3.11 and
3.14. Tests use synthetic data and fake clients: they do not log into accounts
or mutate a real library. The browser export is exercised with a mocked browser
environment on Node.js.

The XPI has also been smoke-tested in an isolated Zotero 10.0.6 profile on macOS:
installation/menu cleanup, native creates/updates, timestamp/tag verification,
idempotence, complete file imports, private CSV backups, and isolated browser/API
cookie contexts. Interactive Wikipedia sign-in and real account deletion are not
part of automated testing. Windows/Linux CI validates the portable code and XPI
build, not the native Zotero GUI on those platforms.

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
