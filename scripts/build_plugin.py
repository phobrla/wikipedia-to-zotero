"""Build the Zotero XPI from an explicit source-only allowlist."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main() -> None:
    """Build an installable, platform-independent XPI without copying user data."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("dist"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "plugin" / "manifest.json").read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / f"wikipedia-to-zotero-{manifest['version']}.xpi"
    files = ["manifest.json", "bootstrap.js", "core.js", "plugin.js"]
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(root / "plugin" / name, name)
        archive.write(root / "LICENSE", "LICENSE")
    with ZipFile(destination) as archive:
        if archive.testzip() is not None or sorted(archive.namelist()) != sorted([*files, "LICENSE"]):
            raise RuntimeError("Plugin archive verification failed")
    print(destination.resolve())


if __name__ == "__main__":
    main()
