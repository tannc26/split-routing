#!/usr/bin/env python3
"""Submit a built extension zip to extensions.gnome.org.

The upload page is a shell: its form carries no action, and the browser posts
the fields to an endpoint the page names in a data attribute, which answers in
JSON. So this logs in with a real account and does the same, which is why the
credentials belong in CI secrets and nowhere else:

    EGO_USERNAME, EGO_PASSWORD

Nothing about the form is hard-coded. The endpoint, the fields and the values
their checkboxes carry are all read from the page, and anything unrecognised
stops the run rather than being guessed at — the previous generation of this
script guessed `gplv2_compliant`, and the site now calls that field
`shell_license_compliant`.

Submitting is not publishing. Every uploaded version waits in the human review
queue before it appears on the site.

    publish-ego.py <extension.zip> [--dry-run]
"""

import os
import re
import sys
import html
import json
import pathlib
import urllib.parse

try:
    import requests
except ImportError:
    sys.exit("This needs the 'requests' package: pip install requests")

BASE = "https://extensions.gnome.org"
LOGIN = f"{BASE}/accounts/login/"
UPLOAD = f"{BASE}/upload/"

ATTR_RE = re.compile(r'(\w[\w-]*)\s*=\s*"([^"]*)"')


def attrs_of(tag):
    return {k.lower(): html.unescape(v) for k, v in ATTR_RE.findall(tag)}


def upload_endpoint(markup):
    """The URL the upload page tells its own JavaScript to post to."""
    for tag in re.findall(r"<div\b[^>]*>", markup, re.I):
        attrs = attrs_of(tag)
        if attrs.get("id") == "upload-page-config" and attrs.get("data-upload-api-url"):
            return urllib.parse.urljoin(BASE, attrs["data-upload-api-url"])
    return None


def form_fields(markup):
    """Every field to post besides the file, with the value the page gives it.

    A checkbox carries its own value attribute — the site's are "true", not the
    "on" that a bare checkbox would send.
    """
    fields, unexpected = {}, []
    for tag in re.findall(r"<input\b[^>]*>", markup, re.I):
        attrs = attrs_of(tag)
        name, kind = attrs.get("name"), attrs.get("type", "text").lower()
        if not name or kind in ("file", "submit", "button"):
            continue
        if kind in ("hidden", "checkbox"):
            fields[name] = attrs.get("value") or "on"
        else:
            unexpected.append(f"{name} ({kind})")
    return fields, unexpected


def report(payload):
    """Turn the endpoint's JSON complaint into one readable line."""
    if isinstance(payload, list):
        return "; ".join(str(error) for error in payload)
    if isinstance(payload, dict):
        return "; ".join(
            f"{field}: {' '.join(errors) if isinstance(errors, list) else errors}"
            for field, errors in payload.items())
    return str(payload)


def main():
    arguments = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv[1:]
    if len(arguments) != 1:
        sys.exit(f"usage: {sys.argv[0]} <extension.zip> [--dry-run]")

    zip_path = pathlib.Path(arguments[0])
    if not zip_path.is_file():
        sys.exit(f"no such file: {zip_path}")

    username = os.environ.get("EGO_USERNAME")
    password = os.environ.get("EGO_PASSWORD")
    if not username or not password:
        sys.exit("EGO_USERNAME and EGO_PASSWORD must be set")

    session = requests.Session()
    session.headers["User-Agent"] = "split-routing-release/1.0"

    session.get(LOGIN, timeout=30).raise_for_status()
    token = session.cookies.get("csrftoken")
    if not token:
        sys.exit("extensions.gnome.org set no csrftoken cookie; the login page has changed")

    answer = session.post(
        LOGIN,
        data={"csrfmiddlewaretoken": token, "username": username,
              "password": password, "next": "/upload/"},
        headers={"Referer": LOGIN},
        timeout=30,
    )
    answer.raise_for_status()
    if "/accounts/login" in answer.url or "correct username and password" in answer.text:
        sys.exit("login rejected: check EGO_USERNAME and EGO_PASSWORD")
    print(f"logged in as {username}")

    page = session.get(UPLOAD, timeout=30)
    page.raise_for_status()
    if "/accounts/login" in page.url:
        sys.exit("the upload page still redirects to the login page")

    endpoint = upload_endpoint(page.text)
    if not endpoint:
        sys.exit("the upload page no longer declares data-upload-api-url; "
                 "upload by hand and update this script")

    fields, unexpected = form_fields(page.text)
    if unexpected:
        sys.exit("the upload form has fields this script cannot fill: "
                 f"{', '.join(unexpected)}. Upload by hand and update this script.")
    fields["csrfmiddlewaretoken"] = session.cookies.get(
        "csrftoken", fields.get("csrfmiddlewaretoken", ""))

    shown = ", ".join(f"{k}={v}" for k, v in sorted(fields.items())
                      if k != "csrfmiddlewaretoken")
    print(f"endpoint: {endpoint}")
    print(f"fields  : {shown}")
    print(f"file    : {zip_path.name} ({zip_path.stat().st_size} bytes)")

    if dry_run:
        print("dry run: nothing was submitted")
        return

    with zip_path.open("rb") as handle:
        result = session.post(
            endpoint,
            data=fields,
            files={"source": (zip_path.name, handle, "application/zip")},
            headers={"Referer": UPLOAD, "X-CSRFToken": fields["csrfmiddlewaretoken"]},
            timeout=180,
        )

    try:
        payload = result.json()
    except json.JSONDecodeError:
        sys.exit(f"the endpoint answered HTTP {result.status_code} but not in JSON; "
                 "upload by hand and update this script")

    if not result.ok:
        sys.exit(f"upload rejected (HTTP {result.status_code}): {report(payload)}")

    link = payload.get("link") if isinstance(payload, dict) else None
    print(f"submitted: {urllib.parse.urljoin(BASE, link) if link else payload}")
    print("It is now in the review queue. A person has to approve it before it "
          "appears on extensions.gnome.org.")


if __name__ == "__main__":
    main()
