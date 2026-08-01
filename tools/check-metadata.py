#!/usr/bin/env python3
"""Check metadata.json against the things extensions.gnome.org rejects for.

Catching these here is the point: a reviewer's time is a scarce resource, and
every one of these has bounced a real submission.
"""

import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
UUID_RE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$")

problems = []


def check(condition, message):
    if not condition:
        problems.append(message)


meta = json.loads((ROOT / "metadata.json").read_text())

for field in ("name", "description", "uuid", "shell-version", "settings-schema"):
    check(meta.get(field), f"metadata.json is missing {field!r}")

uuid = meta.get("uuid", "")
check(UUID_RE.match(uuid),
      f"uuid {uuid!r} must be name@namespace, letters/digits/._- only")
check(not uuid.endswith("@gnome.org"),
      "uuid must not use the gnome.org namespace")
# GNOME Shell finds an extension by directory name, so an installed copy has
# to sit in a directory named exactly after the uuid. A source checkout does
# not: it is named after the repository. Judge only directories that claim to
# be an installed extension, which is what the '@' says.
check("@" not in ROOT.name or ROOT.name == uuid,
      f"this looks like an installed extension directory, but it is named "
      f"{ROOT.name!r} while the uuid is {uuid!r}; GNOME Shell looks the "
      "extension up by directory name and would not find it")

versions = meta.get("shell-version", [])
check(isinstance(versions, list) and versions, "shell-version must be a non-empty list")
for version in versions:
    check(isinstance(version, str) and re.fullmatch(r"\d+(\.\d+)?", version),
          f"shell-version entry {version!r} must be a version string such as \"46\"")
check(len({v.split('.')[0] for v in versions}) == len(versions),
      "shell-version lists the same major release twice")

# The schema the extension asks for has to be the schema that ships with it.
schemas = sorted((ROOT / "schemas").glob("*.gschema.xml"))
check(len(schemas) == 1, f"expected exactly one gschema.xml, found {len(schemas)}")
if schemas:
    declared = {s.get("id") for s in ET.parse(schemas[0]).getroot().findall("schema")}
    check(meta.get("settings-schema") in declared,
          f"settings-schema {meta.get('settings-schema')!r} is not declared in "
          f"{schemas[0].name} (which declares {sorted(declared)})")

check(not (ROOT / "schemas" / "gschemas.compiled").exists() or
      "gschemas.compiled" in (ROOT / ".gitignore").read_text(),
      "schemas/gschemas.compiled must not be committed; it is a build artifact")

check((ROOT / "LICENSE").exists(),
      "no LICENSE file; extensions must be GPL-2.0-or-later or compatible")

url = meta.get("url", "")
check(url.startswith("https://"), f"url {url!r} should be an https link reviewers can open")

if problems:
    print(f"metadata check failed ({len(problems)} problem(s)):")
    for problem in problems:
        print(f"  - {problem}")
    sys.exit(1)

print(f"metadata OK: {meta['name']} {meta.get('version-name', '?')} "
      f"({uuid}) for GNOME Shell {', '.join(versions)}")
