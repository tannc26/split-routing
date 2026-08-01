# Split Routing

A GNOME Shell extension for split routing: send chosen subnets out chosen
network cards, and pick which card carries the default route, so two networks
can be used at the same time.

Typical use: a work LAN on Ethernet that owns `10.0.0.0/8`, while Wi-Fi keeps
the internet — without dropping either.

## How it works

* A **rule** is a subnet (CIDR) plus the card it should go out. IPv4 and IPv6
  are both supported. Gateways are never typed in: they are detected per card,
  from the card's own gateway or from its DHCP lease.
* The **default-route card** carries everything no rule matches. Every other
  connected card is marked `never-default`, for IPv4 and IPv6, so the default
  route is unambiguous.
* Nothing happens until you **left click the panel button**, which switches
  `DIRECT` ⇄ `SPLIT`. **Right click** opens the settings.

## Safety

* Every change goes through NetworkManager over D-Bus. No root, no scripts,
  no subprocesses.
* Only the **running** connection is changed, via `Device.reapply()`. Saved
  profiles are never written to, so a reboot, a NetworkManager restart or
  reconnecting a card returns the machine to its normal routing.
* Switching back undoes **exactly** what was applied. Routes you already had
  are left alone, and each card's previous `never-default` value is restored
  rather than assumed.
* If part of a switch fails, or stops being in effect later because a card
  dropped, the icon turns into a warning and a notification names exactly what
  was lost — rather than the panel claiming everything is fine. The undo list
  still covers whatever did change.

## Requirements

GNOME Shell 45 – 51 (Ubuntu 23.10 through 26.04 LTS) and NetworkManager.

`reapply` needs the polkit action
`org.freedesktop.NetworkManager.network-control`, which is granted to local
active sessions by default on most distributions. Check yours with:

```sh
nmcli general permissions | grep network-control
```

## Manual install

```sh
git clone https://github.com/tannc28/split-routing.git \
    ~/.local/share/gnome-shell/extensions/split-routing@tannc28
glib-compile-schemas ~/.local/share/gnome-shell/extensions/split-routing@tannc28/schemas
```

Log out and back in — the Shell only scans for new extension directories at
start-up — then enable it:

```sh
gnome-extensions enable split-routing@tannc28
```

## Download

The newest build is always at the same address:

    https://github.com/tannc28/split-routing/releases/latest/download/split-routing@tannc28.shell-extension.zip

## Releasing

Every push to `main` is checked, tested and packaged. CI then makes sure a
release exists for whatever `version-name` says in `metadata.json`: if there
is no `v<version-name>` tag yet it creates the tag, the release and attaches
the zip. So releasing is one edit:

```jsonc
// metadata.json
"version-name": "2.1"
```

Push that, and `v2.1` appears with its zip. Nothing else is tagged or
published by hand. `"version"` is left alone — extensions.gnome.org assigns
that number itself.

## Submitting to extensions.gnome.org

The upload page is a shell whose form has no action: the browser posts the
fields to the endpoint the page names in `data-upload-api-url`, which answers
in JSON. CI does the same, signed in with `EGO_USERNAME` and `EGO_PASSWORD`
from the `extensions.gnome.org` environment. Submitting is not publishing:
every version waits in the human review queue either way.

`tools/publish-ego.py --dry-run` signs in and reads the form without sending
anything, which is the way to check the site has not moved underneath it.

It does not happen on its own unless asked for:

* **Actions → CI → Run workflow**, tick *Also submit this build*, to send
  whatever `main` currently builds.
* Set the repository variable `AUTO_SUBMIT` to `true` to also send every new
  release the moment it is made.

Submitting cannot be undone, so the default is neither.

## Undo from a terminal

```sh
nmcli device reapply <interface>
```

No root needed; this discards every runtime change on that card, including
this extension's.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
