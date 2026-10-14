"""Import Wikipedia saved lists through the supported Zotero 10 local API."""

from __future__ import annotations

import argparse
import csv
import getpass
import hashlib
import http.cookiejar
import json
import os
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
ZOTERO_API = "http://127.0.0.1:23119/api/"
USER_AGENT = "WikipediaToZotero/0.1 (https://github.com/phobrla/wikipedia-to-zotero)"
KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
JsonObject = dict[str, Any]
ArticleID = tuple[str, str]
CSV_FIELDS = ["title", "url", "date_added", "tags", "extra", "saved_lists"]


class ImportFailure(Exception):
    """An actionable authentication, validation, or import error."""


class HTTPFailure(ImportFailure):
    """An HTTP failure with a status code but without a sensitive response body."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def saved_time(value: str) -> str:
    """Validate a timezone-aware timestamp and normalize it to UTC."""
    try:
        parsed = datetime.fromisoformat(value)
    except (ValueError, TypeError) as exc:
        raise ImportFailure("Invalid saved timestamp in source data") from exc
    if parsed.tzinfo is None:
        raise ImportFailure("Saved timestamps must include a timezone")
    return parsed.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def identity(url: str) -> ArticleID | None:
    """Normalize article URL spelling, preserving language and article case."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().replace(".m.wikipedia.org", ".wikipedia.org")
    if parts.scheme not in {"http", "https"} or not host.endswith(".wikipedia.org"):
        return None
    if parts.username or parts.password or parts.netloc != parts.hostname:
        return None
    if parts.path.startswith("/wiki/"):
        title = unquote(parts.path[6:])
    elif parts.path == "/w/index.php":
        title = parse_qs(parts.query).get("title", [""])[0]
    else:
        return None
    if not title:
        return None
    return host, unicodedata.normalize("NFC", title.replace("_", " "))


def stable_key(article: ArticleID) -> str:
    """Use a stable Zotero key so ambiguous network failures cannot create duplicates."""
    number = int.from_bytes(hashlib.sha256(json.dumps(article).encode()).digest()[:5], "big")
    chars = []
    for _ in range(8):
        number, remainder = divmod(number, len(KEY_ALPHABET))
        chars.append(KEY_ALPHABET[remainder])
    return "".join(chars)


def state_directory(platform: str | None = None) -> Path:
    """Choose a per-user private state location on Windows, Linux, or macOS."""
    platform = platform or sys.platform
    if platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    elif platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state")))
    return root / "wikipedia-to-zotero"


def private_json(path: Path, data: Any) -> None:
    """Atomically save user data; never store credentials or authorization keys."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


class Client:
    """HTTP JSON client with in-memory sessions and credential-safe diagnostics."""

    def __init__(self) -> None:
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(
        self,
        url: str,
        payload: Any = None,
        *,
        form: bool = False,
        headers: dict[str, str] | None = None,
    ) -> tuple[Any, Any]:
        """Send JSON or a form; do not log request bodies, cookies, or keys."""
        merged = {"User-Agent": USER_AGENT, **(headers or {})}
        data = None
        if payload is not None:
            data = (urlencode(payload) if form else json.dumps(payload)).encode("utf-8")
            merged["Content-Type"] = (
                "application/x-www-form-urlencoded" if form else "application/json"
            )
        req = Request(url, data=data, headers=merged)
        try:
            with self.opener.open(req, timeout=300) as response:
                raw = response.read()
                return (json.loads(raw) if raw else None), response.headers
        except HTTPError as exc:
            raise HTTPFailure(
                exc.code,
                f"{req.get_method()} {urlsplit(url).path}: HTTP {exc.code}. "
                "Check service permissions and retry; no credentials were logged.",
            ) from None
        except (URLError, TimeoutError) as exc:
            raise ImportFailure(
                f"Connection to {urlsplit(url).hostname} failed. "
                "For Zotero, ensure it is running and its local API is enabled. "
                "Rerun to resume safely."
            ) from exc
        except json.JSONDecodeError as exc:
            raise ImportFailure("The service returned invalid JSON") from exc


class Wikipedia:
    """Read saved lists from an authenticated MediaWiki session."""

    def __init__(self, client: Client) -> None:
        self.client = client

    def query(self, parameters: JsonObject, *, post: bool = False) -> JsonObject:
        parameters = {"format": "json", "formatversion": "2", **parameters}
        if post:
            result, _ = self.client.request(WIKIPEDIA_API, parameters, form=True)
        else:
            result, _ = self.client.request(WIKIPEDIA_API + "?" + urlencode(parameters))
        if "error" in result:
            raise ImportFailure(f"Wikipedia API error: {result['error'].get('code', 'unknown')}")
        return result

    def login(self, username: str, password: str) -> None:
        """Authenticate, prompting for supported email or authenticator challenges."""
        token = self.query({"action": "query", "meta": "tokens", "type": "login"})
        login_token = token["query"]["tokens"]["logintoken"]
        result = self.query(
            {
                "action": "clientlogin",
                "username": username,
                "password": password,
                "logintoken": login_token,
                "loginreturnurl": "https://en.wikipedia.org/",
            },
            post=True,
        )["clientlogin"]
        for _ in range(3):
            if result["status"] == "PASS":
                return
            fields = {
                name
                for challenge in result.get("requests", [])
                for name in challenge.get("fields", {})
            }
            supported = fields & {"token", "OATHToken"}
            if result["status"] != "UI" or len(supported) != 1:
                raise ImportFailure(
                    "Wikipedia login needs browser interaction or credentials were rejected. "
                    "Use the documented browser export and --source instead."
                )
            field = next(iter(supported))
            code = getpass.getpass("Wikipedia email/authenticator verification code: ")
            result = self.query(
                {
                    "action": "clientlogin",
                    "logincontinue": "1",
                    "logintoken": login_token,
                    field: code,
                },
                post=True,
            )["clientlogin"]
        raise ImportFailure("Wikipedia verification did not complete; use browser export instead")

    def pages(self, parameters: JsonObject, field: str) -> list[JsonObject]:
        """Follow continuation tokens until the endpoint is exhausted."""
        output: list[JsonObject] = []
        continuation: JsonObject = {}
        while True:
            result = self.query({"action": "query", **parameters, **continuation})
            output.extend(result.get("query", {}).get(field, []))
            continuation = result.get("continue", {})
            if not continuation:
                return output

    def snapshot(self) -> JsonObject:
        lists = self.pages({"meta": "readinglists", "rllimit": "12"}, "readinglists")
        entries = []
        for start in range(0, len(lists), 100):
            identifiers = "|".join(str(item["id"]) for item in lists[start : start + 100])
            entries.extend(
                self.pages(
                    {
                        "list": "readinglistentries",
                        "rlelists": identifiers,
                        "rlelimit": "100",
                    },
                    "readinglistentries",
                )
            )
        return {"lists": lists, "entries": entries}


@dataclass
class Article:
    """One Wikipedia article and all of its reading-list memberships."""

    canonical: ArticleID
    title: str
    url: str
    saved: str
    tags: list[str]
    provenance: list[str]


def articles_from_snapshot(snapshot: JsonObject) -> list[Article]:
    """Reject incomplete exports before any Zotero write is attempted."""
    try:
        if (
            not isinstance(snapshot, dict)
            or not isinstance(snapshot.get("lists"), list)
            or not isinstance(snapshot.get("entries"), list)
        ):
            raise ImportFailure("Source must contain lists and entries arrays")
        lists = {item["id"]: item for item in snapshot["lists"]}
        entries = snapshot["entries"]
        if len(lists) != len(snapshot["lists"]):
            raise ImportFailure("Duplicate reading-list IDs in source")
        counts = Counter(item["listId"] for item in entries)
        if set(counts) - set(lists):
            raise ImportFailure("An entry references an unknown reading list")
        if len({item["id"] for item in entries}) != len(entries):
            raise ImportFailure("Duplicate entry IDs in source")
        for key, item in lists.items():
            if counts[key] != item["size"]:
                raise ImportFailure("Incomplete export: a reading-list size does not match")
            if not isinstance(item["name"], str) or not item["name"].strip():
                raise ImportFailure("Reading-list names must be nonempty strings")
            if "\n" in item["name"] or "\r" in item["name"]:
                raise ImportFailure("Reading-list names containing line breaks are unsupported")
        grouped: dict[ArticleID, list[JsonObject]] = defaultdict(list)
        for entry in entries:
            project = urlsplit(entry["project"])
            if project.scheme != "https" or project.path not in {"", "/"} or project.query:
                raise ImportFailure("Source projects must be HTTPS Wikipedia origins")
            if not isinstance(entry["title"], str) or not entry["title"].strip():
                raise ImportFailure("Source article titles must be nonempty strings")
            url = (
                entry["project"].rstrip("/")
                + "/wiki/"
                + quote(entry["title"].replace(" ", "_"), safe="()_")
            )
            canonical = identity(url)
            if canonical is None:
                raise ImportFailure("Source contains an unsupported Wikipedia project URL")
            grouped[canonical].append(
                {**entry, "url": url, "created": saved_time(entry["created"])}
            )
        articles = []
        for canonical, memberships in grouped.items():
            saved = min(item["created"] for item in memberships)
            tags = sorted({lists[item["listId"]]["name"] for item in memberships})
            provenance = [f"Wikipedia saved: {saved}"] + [
                f"Wikipedia list saved: {lists[item['listId']]['name']} | {item['created']}"
                for item in sorted(memberships, key=lambda item: item["listId"])
            ]
            first = memberships[0]
            articles.append(
                Article(canonical, first["title"], first["url"], saved, tags, provenance)
            )
        return articles
    except (KeyError, TypeError, ValueError) as exc:
        raise ImportFailure("Malformed saved-list export; see the documented JSON format") from exc


@dataclass
class PlannedItem:
    """Expected stored metadata and the optional minimal write."""

    key: str
    article: Article
    payload: JsonObject | None
    operation: str


def plan_import(
    articles: list[Article], existing: list[JsonObject]
) -> tuple[list[PlannedItem], list[JsonObject]]:
    """Match only bibliography items, never child snapshots or attachment URLs."""
    by_url: dict[ArticleID, list[JsonObject]] = defaultdict(list)
    by_key = {item["key"]: item for item in existing}
    for item in existing:
        if item["itemType"] in {"attachment", "note", "annotation"}:
            continue
        canonical = identity(item.get("url", ""))
        if canonical is not None:
            by_url[canonical].append(item)
    planned = []
    backup = []
    new_keys: set[str] = set()
    accessed = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    for article in articles:
        matches = by_url.get(article.canonical, [])
        if matches:
            for old in matches:
                backup.append(old)
                old_tags = {tag["tag"] for tag in old.get("tags", [])}
                tags = old.get("tags", []) + [
                    {"tag": tag} for tag in article.tags if tag not in old_tags
                ]
                lines = old.get("extra", "").splitlines()
                lines += [line for line in article.provenance if line not in lines]
                fields = {"dateAdded": article.saved, "tags": tags, "extra": "\n".join(lines)}
                changed = any(old.get(name) != value for name, value in fields.items())
                payload = (
                    {"key": old["key"], "version": old["version"], **fields} if changed else None
                )
                planned.append(
                    PlannedItem(old["key"], article, payload, "update" if changed else "unchanged")
                )
        else:
            key = stable_key(article.canonical)
            if key in by_key or key in new_keys:
                raise ImportFailure("Generated item-key collision; refusing to overwrite an item")
            new_keys.add(key)
            payload = {
                "key": key,
                "version": 0,
                "itemType": "encyclopediaArticle",
                "title": article.title,
                "url": article.url,
                "encyclopediaTitle": "Wikipedia",
                "language": article.canonical[0].split(".")[0],
                "dateAdded": article.saved,
                "accessDate": accessed,
                "tags": [{"tag": tag} for tag in article.tags],
                "extra": "\n".join(article.provenance),
                "creators": [],
                "collections": [],
                "relations": {},
            }
            planned.append(PlannedItem(key, article, payload, "create"))
    return planned, backup


def export_csv(path: Path, snapshot: JsonObject) -> int:
    """Export one UTF-8 CSV row per article without contacting or modifying Zotero."""
    articles = articles_from_snapshot(snapshot)
    names = {item["id"]: item["name"] for item in snapshot["lists"]}
    if len(set(names.values())) != len(names):
        raise ImportFailure("CSV export requires unique reading-list names")
    memberships: dict[ArticleID, list[JsonObject]] = defaultdict(list)
    for entry in snapshot["entries"]:
        url = (
            entry["project"].rstrip("/")
            + "/wiki/"
            + quote(entry["title"].replace(" ", "_"), safe="()_")
        )
        canonical = identity(url)
        if canonical is None:
            raise ImportFailure("Source contains an unsupported Wikipedia project URL")
        memberships[canonical].append(
            {"name": names[entry["listId"]], "created": saved_time(entry["created"])}
        )
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
            writer.writeheader()
            for article in articles:
                writer.writerow(
                    {
                        "title": article.title,
                        "url": article.url,
                        "date_added": article.saved,
                        "tags": json.dumps(article.tags, ensure_ascii=False),
                        "extra": "\n".join(article.provenance),
                        "saved_lists": json.dumps(
                            memberships[article.canonical], ensure_ascii=False
                        ),
                    }
                )
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        # A partial export must not be mistaken for a complete re-import backup.
        path.unlink()
        raise
    return len(articles)


def snapshot_from_csv(path: Path) -> JsonObject:
    """Read this tool's CSV format, validating redundant metadata before any writes."""
    lists: list[JsonObject] = []
    entries: list[JsonObject] = []
    list_ids: dict[str, int] = {}
    seen: set[ArticleID] = set()
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, strict=True)
        if reader.fieldnames != CSV_FIELDS:
            raise ImportFailure("CSV columns do not match this tool's export format")
        for row_number, row in enumerate(reader, start=2):
            try:
                if None in row or any(value is None for value in row.values()):
                    raise ImportFailure("CSV row has missing or extra fields")
                canonical = identity(row["url"])
                if canonical is None or canonical in seen:
                    raise ImportFailure("CSV contains an invalid or duplicate article URL")
                if canonical[1] != unicodedata.normalize("NFC", row["title"].replace("_", " ")):
                    raise ImportFailure("CSV title does not match the article URL")
                tags = json.loads(row["tags"])
                saved_lists = json.loads(row["saved_lists"])
                if (
                    not isinstance(tags, list)
                    or not all(isinstance(tag, str) for tag in tags)
                    or not isinstance(saved_lists, list)
                    or not saved_lists
                ):
                    raise ImportFailure("CSV tags and saved_lists must be JSON arrays")
                if any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("name"), str)
                    or not item["name"].strip()
                    or "\n" in item["name"]
                    or "\r" in item["name"]
                    for item in saved_lists
                ):
                    raise ImportFailure("CSV saved_lists contains an invalid list name")
                names = [item["name"] for item in saved_lists]
                if len(names) != len(set(names)) or sorted(tags) != sorted(names):
                    raise ImportFailure("CSV tags do not match unique saved-list names")
                times = [saved_time(item["created"]) for item in saved_lists]
                if saved_time(row["date_added"]) != min(times):
                    raise ImportFailure("CSV date_added is not the earliest saved timestamp")
                expected_extra = {f"Wikipedia saved: {min(times)}"} | {
                    f"Wikipedia list saved: {item['name']} | {created}"
                    for item, created in zip(saved_lists, times, strict=True)
                }
                if set(row["extra"].splitlines()) != expected_extra:
                    raise ImportFailure("CSV Extra does not match the saved-list timestamps")
                seen.add(canonical)
                for item, created in zip(saved_lists, times, strict=True):
                    name = item["name"]
                    if name not in list_ids:
                        list_ids[name] = len(lists) + 1
                        lists.append({"id": list_ids[name], "name": name, "size": 0})
                    identifier = list_ids[name]
                    lists[identifier - 1]["size"] += 1
                    entries.append(
                        {
                            "id": len(entries) + 1,
                            "listId": identifier,
                            "project": "https://" + canonical[0],
                            "title": row["title"],
                            "created": created,
                        }
                    )
            except (ImportFailure, ValueError, KeyError, TypeError) as exc:
                raise ImportFailure(f"Invalid CSV record {row_number}: {exc}") from exc
    snapshot = {"lists": lists, "entries": entries}
    articles_from_snapshot(snapshot)
    return snapshot


class Zotero:
    """Use Zotero's supported local API without requesting account credentials."""

    def __init__(self, client: Client) -> None:
        self.client = client
        self.headers: dict[str, str] = {}

    def read(self, path: str) -> Any:
        result, headers = self.client.request(ZOTERO_API + path, headers=self.headers)
        server_id = headers.get("Zotero-Server-ID")
        if not server_id:
            raise ImportFailure("Zotero 10 or later is required for local API writes")
        self.headers["Zotero-Server-ID"] = server_id
        return result

    def existing_items(self) -> list[JsonObject]:
        """Read every record to detect URL matches and generated-key collisions."""
        wrappers = self.read("users/0/items")
        return [item["data"] for item in wrappers]

    def authorize(self) -> None:
        """Ask the desktop client for runtime permission; keep the key in memory."""
        result, _ = self.client.request(
            ZOTERO_API + "local/authorize",
            {"appName": "Wikipedia to Zotero"},
            headers=self.headers,
        )
        if not result.get("key"):
            raise ImportFailure("Zotero write permission was not granted")
        self.headers["Zotero-API-Key"] = result["key"]

    def write_batch(self, batch: list[PlannedItem]) -> None:
        """Accept both current and legacy success maps, counting each index once."""
        import secrets

        token = secrets.token_hex(16)

        def send() -> JsonObject:
            result, _ = self.client.request(
                ZOTERO_API + "users/0/items",
                [item.payload for item in batch],
                headers={**self.headers, "Zotero-Write-Token": token},
            )
            return result

        try:
            result = send()
        except HTTPFailure as exc:
            if exc.status != 401:
                raise
            print("Zotero needs another write approval (choose Always Allow for batches).")
            self.authorize()
            result = send()
        acknowledged = (
            set(result.get("successful", {}))
            | set(result.get("success", {}))
            | set(result.get("unchanged", {}))
        )
        if result.get("failed") or acknowledged != {str(index) for index in range(len(batch))}:
            codes = sorted({str(error.get("code")) for error in result.get("failed", {}).values()})
            raise ImportFailure(
                f"Zotero rejected a batch (codes: {', '.join(codes) or 'incomplete response'}). "
                "Some items may already have been saved. Rerun to resume without duplicates."
            )

    def verify(self, items: list[PlannedItem]) -> None:
        """Read back URLs, exact saved times, folder tags, and per-folder timestamps."""
        for start in range(0, len(items), 100):
            batch = items[start : start + 100]
            wrappers = self.read("users/0/items?itemKey=" + ",".join(item.key for item in batch))
            actual = {wrapper["key"]: wrapper["data"] for wrapper in wrappers}
            for planned in batch:
                data = actual.get(planned.key)
                article = planned.article
                if (
                    data is None
                    or identity(data.get("url", "")) != article.canonical
                    or data.get("dateAdded") != article.saved
                    or not set(article.tags) <= {tag["tag"] for tag in data.get("tags", [])}
                    or not set(article.provenance) <= set(data.get("extra", "").splitlines())
                ):
                    raise ImportFailure(
                        f"Read-back verification failed for Zotero item {planned.key}"
                    )


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; credentials are prompted or read only from explicit environment names."""
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument(
        "--source", type=Path, help="Import a browser-exported saved-list JSON file"
    )
    sources.add_argument(
        "--source-csv", type=Path, help="Re-import a CSV generated by --export-csv"
    )
    parser.add_argument(
        "--export-csv",
        type=Path,
        metavar="PATH",
        help="Export saved items to a new private CSV file and exit without contacting Zotero",
    )
    parser.add_argument(
        "--state-dir", type=Path, default=None, help="Private backup/export directory"
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate and plan without writing")
    parser.add_argument(
        "--yes", action="store_true", help="Skip CLI confirmation, not Zotero permission"
    )
    args = parser.parse_args(argv)
    if args.export_csv and args.dry_run:
        parser.error("--export-csv writes a file and cannot be combined with --dry-run")
    try:
        if args.source:
            with args.source.open(encoding="utf-8") as source:
                snapshot = json.load(source)
        elif args.source_csv:
            snapshot = snapshot_from_csv(args.source_csv)
        else:
            wikipedia = Wikipedia(Client())
            username = os.environ.get("WIKIPEDIA_USERNAME") or input("Wikipedia username: ")
            password = os.environ.get("WIKIPEDIA_PASSWORD") or getpass.getpass(
                "Wikipedia password: "
            )
            wikipedia.login(username, password)
            snapshot = wikipedia.snapshot()
        articles = articles_from_snapshot(snapshot)
        if args.export_csv:
            count = export_csv(args.export_csv, snapshot)
            print(f"Exported {count} articles to {args.export_csv}. Zotero was not contacted.")
            return 0
        zotero = Zotero(Client())
        planned, backup = plan_import(articles, zotero.existing_items())
        summary = {
            "lists": len(snapshot["lists"]),
            "memberships": len(snapshot["entries"]),
            "unique_articles": len(articles),
            "operations": dict(Counter(item.operation for item in planned)),
        }
        print(json.dumps(summary, indent=2))
        if args.dry_run:
            return 0
        writes = [item for item in planned if item.payload is not None]
        if (
            writes
            and not args.yes
            and input(
                "Import these items and update existing saved timestamps/tags? [y/N] "
            ).lower()
            != "y"
        ):
            print("Cancelled; Zotero was not changed.")
            return 0
        directory = args.state_dir or state_directory()
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        private_json(directory / f"snapshot-{stamp}.json", snapshot)
        private_json(directory / f"backup-{stamp}.json", backup)
        if writes:
            print("Approve the import in Zotero's permission dialog.", flush=True)
            zotero.authorize()
            for start in range(0, len(writes), 50):
                batch = writes[start : start + 50]
                zotero.write_batch(batch)
                if start == 0:
                    zotero.verify(batch)
                print(f"Saved {min(start + 50, len(writes))}/{len(writes)} changes", flush=True)
        zotero.verify(planned)
        private_json(
            directory / f"verification-{stamp}.json", {**summary, "verified": len(planned)}
        )
        print(f"Verified all {len(planned)} Zotero items. Backups: {directory}")
        return 0
    except (ImportFailure, OSError, json.JSONDecodeError, csv.Error, EOFError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(
            "Interrupted. Rerun to resume; existing items will not be duplicated.", file=sys.stderr
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
