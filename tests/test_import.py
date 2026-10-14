"""Portable regression tests with synthetic saved lists and in-memory Zotero."""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import wikipedia_to_zotero as app


def source():
    return {
        "lists": [
            {"id": 1, "name": "default", "size": 1},
            {"id": 2, "name": "Science", "size": 1},
        ],
        "entries": [
            {"id": 11, "listId": 1, "project": "https://en.wikipedia.org",
             "title": "Example article", "created": "2020-01-01T02:00:00+02:00"},
            {"id": 12, "listId": 2, "project": "https://en.wikipedia.org",
             "title": "Example article", "created": "2021-01-01T00:00:00Z"},
        ],
    }


def bibliography(key="ABCD2345", **fields):
    return {
        "key": key, "version": 4, "itemType": "encyclopediaArticle",
        "title": "Preserved title", "url": "https://en.m.wikipedia.org/wiki/Example_article#History",
        "dateAdded": "2025-01-01T00:00:00Z", "extra": "Keep my notes",
        "tags": [{"tag": "existing", "type": 1}], "collections": ["EFGH2345"],
        **fields,
    }


class FakeClient:
    def __init__(self, items=None):
        self.items = {item["key"]: copy.deepcopy(item) for item in items or []}
        self.authorizations = 0
        self.writes = 0

    def request(self, url, payload=None, **kwargs):
        headers = {"Zotero-Server-ID": "synthetic-test-instance"}
        if url.endswith("local/authorize"):
            self.authorizations += 1
            return {"key": "synthetic-permission", "remember": True}, headers
        if payload is None:
            selected = url.split("itemKey=", 1)[1].split(",") if "itemKey=" in url else self.items
            return [
                {"key": key, "data": copy.deepcopy(self.items[key])}
                for key in selected if key in self.items
            ], headers
        self.writes += 1
        result = {"successful": {}, "success": {}, "failed": {}, "unchanged": {}}
        for index, data in enumerate(payload):
            key = data["key"]
            old = self.items.get(key, {})
            if old and old["version"] != data["version"]:
                result["failed"][str(index)] = {"code": 412}
                continue
            stored = {**old, **copy.deepcopy(data)}
            stored["version"] = old.get("version", 0) + 1
            self.items[key] = stored
            result["successful"][str(index)] = {"key": key, "data": stored}
            result["success"][str(index)] = key
        return result, headers


class SourceTests(unittest.TestCase):
    def test_memberships_tags_and_earliest_timestamp(self):
        articles = app.articles_from_snapshot(source())
        self.assertEqual(len(articles), 1)
        article = articles[0]
        self.assertEqual(article.saved, "2020-01-01T00:00:00Z")
        self.assertEqual(article.tags, ["Science", "default"])
        self.assertIn("Science | 2021-01-01T00:00:00Z", article.provenance[2])

    def test_incomplete_source_rejected(self):
        snapshot = source()
        snapshot["entries"].pop()
        with self.assertRaisesRegex(app.ImportFailure, "Incomplete"):
            app.articles_from_snapshot(snapshot)

    def test_duplicate_entry_ids_rejected(self):
        snapshot = source()
        snapshot["entries"][1]["id"] = 11
        with self.assertRaisesRegex(app.ImportFailure, "Duplicate entry"):
            app.articles_from_snapshot(snapshot)

    def test_duplicate_list_ids_rejected(self):
        snapshot = source()
        snapshot["lists"][1]["id"] = 1
        with self.assertRaisesRegex(app.ImportFailure, "Duplicate reading"):
            app.articles_from_snapshot(snapshot)

    def test_unknown_list_rejected(self):
        snapshot = source()
        snapshot["entries"][1]["listId"] = 999
        with self.assertRaisesRegex(app.ImportFailure, "unknown"):
            app.articles_from_snapshot(snapshot)

    def test_invalid_shape_rejected(self):
        for snapshot in [None, [], {}, {"lists": {}, "entries": []}]:
            with self.subTest(snapshot=snapshot), self.assertRaises(app.ImportFailure):
                app.articles_from_snapshot(snapshot)

    def test_invalid_timestamp_rejected(self):
        for value in ["not a timestamp", "2020-01-01"]:
            snapshot = source()
            snapshot["entries"][0]["created"] = value
            with self.subTest(value=value), self.assertRaises(app.ImportFailure):
                app.articles_from_snapshot(snapshot)

    def test_external_project_rejected(self):
        snapshot = source()
        snapshot["entries"][0]["project"] = "https://example.org"
        with self.assertRaises(app.ImportFailure):
            app.articles_from_snapshot(snapshot)

    def test_unicode_and_language_retained(self):
        snapshot = source()
        snapshot["entries"][1].update(project="https://bg.wikipedia.org", title="\u041f\u0440\u0438\u043c\u0435\u0440")
        self.assertEqual(len(app.articles_from_snapshot(snapshot)), 2)

    def test_empty_export(self):
        self.assertEqual(app.articles_from_snapshot({"lists": [], "entries": []}), [])

    def test_multiline_list_name_rejected(self):
        snapshot = source()
        snapshot["lists"][0]["name"] = "Bad\nName"
        with self.assertRaises(app.ImportFailure):
            app.articles_from_snapshot(snapshot)


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.articles = app.articles_from_snapshot(source())

    def test_mobile_escaped_and_fragment_urls_match(self):
        self.assertEqual(
            app.identity("https://en.m.wikipedia.org/wiki/Example%20article#section"),
            app.identity("http://en.wikipedia.org/w/index.php?title=Example_article"),
        )
        self.assertNotEqual(
            app.identity("https://en.wikipedia.org/wiki/Example"),
            app.identity("https://bg.wikipedia.org/wiki/Example"),
        )
        self.assertIsNone(app.identity("https://notwikipedia.org/wiki/Example"))
        self.assertIsNone(app.identity("https://en.wikipedia.org:999/wiki/Example"))

    def test_new_item_metadata(self):
        planned, backup = app.plan_import(self.articles, [])
        self.assertEqual(backup, [])
        payload = planned[0].payload
        self.assertEqual(payload["itemType"], "encyclopediaArticle")
        self.assertEqual(payload["dateAdded"], "2020-01-01T00:00:00Z")
        self.assertNotIn("date", payload)

    def test_attachment_excluded(self):
        planned, _ = app.plan_import(self.articles, [bibliography(itemType="attachment")])
        self.assertEqual(planned[0].operation, "create")
        self.assertNotEqual(planned[0].key, "ABCD2345")

    def test_existing_item_fields_preserved(self):
        existing = bibliography()
        before = copy.deepcopy(existing)
        planned, backup = app.plan_import(self.articles, [existing])
        self.assertEqual(existing, before)
        self.assertEqual(backup, [before])
        payload = planned[0].payload
        self.assertNotIn("title", payload)
        self.assertNotIn("collections", payload)
        self.assertIn({"tag": "existing", "type": 1}, payload["tags"])
        self.assertTrue(payload["extra"].startswith("Keep my notes\n"))

    def test_existing_duplicates_preserved(self):
        planned, _ = app.plan_import(self.articles, [bibliography(), bibliography("WXYZ2345")])
        self.assertEqual(len(planned), 2)
        self.assertTrue(all(item.operation == "update" for item in planned))

    def test_stable_key_and_collision(self):
        key = app.stable_key(self.articles[0].canonical)
        self.assertEqual(key, app.stable_key(self.articles[0].canonical))
        self.assertEqual(len(key), 8)
        self.assertTrue(set(key) <= set(app.KEY_ALPHABET))
        with self.assertRaisesRegex(app.ImportFailure, "collision"):
            app.plan_import(self.articles, [bibliography(key, url="https://example.org")])

    def test_round_trip_is_idempotent_and_preserves_metadata(self):
        client = FakeClient([bibliography()])
        zotero = app.Zotero(client)
        planned, _ = app.plan_import(self.articles, zotero.existing_items())
        zotero.authorize()
        zotero.write_batch(planned)
        zotero.verify(planned)
        stored = client.items["ABCD2345"]
        self.assertEqual(stored["title"], "Preserved title")
        self.assertEqual(stored["collections"], ["EFGH2345"])
        repeated, _ = app.plan_import(self.articles, zotero.existing_items())
        self.assertEqual(repeated[0].operation, "unchanged")
        self.assertIsNone(repeated[0].payload)

    def test_new_item_rerun_has_no_duplicate(self):
        client = FakeClient()
        zotero = app.Zotero(client)
        planned, _ = app.plan_import(self.articles, zotero.existing_items())
        zotero.authorize()
        zotero.write_batch(planned)
        repeated, _ = app.plan_import(self.articles, zotero.existing_items())
        self.assertEqual(len(client.items), 1)
        self.assertEqual(repeated[0].operation, "unchanged")

    def test_verification_catches_wrong_timestamp(self):
        planned, _ = app.plan_import(self.articles, [])
        client = FakeClient()
        zotero = app.Zotero(client)
        zotero.write_batch(planned)
        client.items[planned[0].key]["dateAdded"] = "2022-01-01T00:00:00Z"
        with self.assertRaisesRegex(app.ImportFailure, "verification failed"):
            zotero.verify(planned)

    def test_conflicting_version_is_not_ignored(self):
        client = FakeClient([bibliography()])
        zotero = app.Zotero(client)
        planned, _ = app.plan_import(self.articles, zotero.existing_items())
        client.items["ABCD2345"]["version"] += 1
        with self.assertRaisesRegex(app.ImportFailure, "412"):
            zotero.write_batch(planned)

    def test_one_time_authorization_is_renewed(self):
        planned, _ = app.plan_import(self.articles, [])
        client = FakeClient()
        original = client.request
        first = True

        def expire_once(url, payload=None, **kwargs):
            nonlocal first
            if payload is not None and url.endswith("/items") and first:
                first = False
                raise app.HTTPFailure(401, "Synthetic expired authorization")
            return original(url, payload, **kwargs)

        client.request = expire_once
        zotero = app.Zotero(client)
        with contextlib.redirect_stdout(io.StringIO()):
            zotero.write_batch(planned)
        self.assertEqual(client.authorizations, 1)
        zotero.verify(planned)


class CLITests(unittest.TestCase):
    def test_platform_state_directories(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": "/windows-user", "XDG_STATE_HOME": "/linux-user"}):
            self.assertEqual(app.state_directory("win32"), Path("/windows-user/wikipedia-to-zotero"))
            self.assertEqual(app.state_directory("linux"), Path("/linux-user/wikipedia-to-zotero"))
            self.assertEqual(
                app.state_directory("darwin"),
                Path.home() / "Library" / "Application Support" / "wikipedia-to-zotero",
            )

    def test_atomic_private_unicode_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "source.json"
            app.private_json(path, {"text": "\u041f\u0440\u0438\u043c\u0435\u0440"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"text": "\u041f\u0440\u0438\u043c\u0435\u0440"})
            self.assertFalse(path.with_suffix(".json.tmp").exists())
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_dry_run_does_not_write_or_prompt_for_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(source()), encoding="utf-8")
            client = FakeClient()
            state = Path(directory) / "state"
            with patch.object(app, "Client", return_value=client), contextlib.redirect_stdout(io.StringIO()):
                code = app.main(["--source", str(path), "--state-dir", str(state), "--dry-run"])
            self.assertEqual(code, 0)
            self.assertFalse(state.exists())
            self.assertEqual(client.writes, 0)
            self.assertEqual(client.authorizations, 0)

    def test_end_to_end_import_and_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(source()), encoding="utf-8")
            state = Path(directory) / "private"
            client = FakeClient()
            args = ["--source", str(path), "--state-dir", str(state), "--yes"]
            with patch.object(app, "Client", return_value=client), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(app.main(args), 0)
                self.assertEqual(app.main(args), 0)
            self.assertEqual(len(client.items), 1)
            self.assertEqual(client.writes, 1)
            self.assertEqual(client.authorizations, 1)
            self.assertEqual(len(list(state.glob("verification-*.json"))), 2)
            for file in state.iterdir():
                self.assertNotIn("synthetic-permission", file.read_text(encoding="utf-8"))

    def test_wikipedia_continuation(self):
        wiki = app.Wikipedia(app.Client())
        responses = [
            {"query": {"readinglists": [{"id": 1}]}, "continue": {"rlcontinue": "next"}},
            {"query": {"readinglists": [{"id": 2}]}},
        ]
        with patch.object(wiki, "query", side_effect=responses) as query:
            result = wiki.pages({"meta": "readinglists"}, "readinglists")
        self.assertEqual(len(result), 2)
        self.assertEqual(query.call_args_list[1].args[0]["rlcontinue"], "next")

    def test_wikipedia_email_verification(self):
        wiki = app.Wikipedia(app.Client())
        responses = [
            {"query": {"tokens": {"logintoken": "synthetic-login-token"}}},
            {"clientlogin": {"status": "UI", "requests": [{"fields": {"token": {}}}]}},
            {"clientlogin": {"status": "PASS"}},
        ]
        with patch.object(wiki, "query", side_effect=responses) as query, \
                patch.object(app.getpass, "getpass", return_value="synthetic-code"):
            wiki.login("example-user", "synthetic-password")
        self.assertEqual(query.call_args_list[-1].args[0]["token"], "synthetic-code")


if __name__ == "__main__":
    unittest.main()
