/* Split Routing — panel indicator.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * State is read from NetworkManager and refreshed from NetworkManager signals,
 * never polled. Every main loop source and every signal connection made here is
 * tracked and torn down in destroy(), which disable() calls.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Engine from './lib/engine.js';

// NetworkManager reports a reapply as several property changes in a row;
// coalesce them into one refresh.
const REFRESH_DEBOUNCE_MS = 400;

// How long after a switch the runtime routing table is allowed to disagree
// with the undo record before the record is treated as stale (microseconds).
const GRACE_US = 5 * 1000 * 1000;

// reapply() returns when NetworkManager accepts the change, not when the
// routing table reflects it, and libnm may update a device's IP config in
// place — in which case notify::ip4-config never fires and nothing would ever
// look again. So after a switch, look again a few times, then stop.
const SETTLE_MS = [1000, 3000, 6000];

const STATE_UI = {
    'direct': {
        label: 'DIRECT',
        icon: 'network-workgroup-symbolic',
        status: 'Normal routing. Click to switch to split routing.',
    },
    'split': {
        label: 'SPLIT',
        icon: 'network-transmit-receive-symbolic',
        status: 'Split routing is active. Click to restore normal routing.',
    },
    // Same label as 'split' on purpose: the switch is either on or off.
    // What is different is the icon, and a notification naming what dropped.
    'partial': {
        label: 'SPLIT',
        icon: 'dialog-warning-symbolic',
        status: 'Split routing is on, but part of it is no longer in effect. Click to restore normal routing.',
    },
};

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function errorText(e) {
    if (e instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(e);
    return e?.message ?? String(e);
}

const Indicator = GObject.registerClass(
class SplitRoutingIndicator extends PanelMenu.Button {
    _init(extension) {
        // dontCreateMenu: this indicator is a switch, not a menu. Without it
        // the base class claims every button press for its own menu — through
        // vfunc_event up to GNOME 49, through a Clutter.ClickGesture from
        // GNOME 50 on — and neither can be overruled from a signal handler.
        super._init(0.5, 'Split Routing', true);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();

        this._sourceIds = new Set();
        this._settingsIds = [];
        this._clientIds = [];
        this._deviceIds = new Map();

        this._client = null;
        this._destroyed = false;
        this._busy = false;
        this._state = 'direct';
        this._refreshId = 0;
        this._graceUntil = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: STATE_UI['direct'].icon,
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 4px;',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        // Left click switches, right click opens the settings.
        this.connect('button-press-event', (_actor, event) => {
            switch (event.get_button()) {
            case Clutter.BUTTON_PRIMARY:
                this._onAction();
                return Clutter.EVENT_STOP;
            case Clutter.BUTTON_SECONDARY:
                this._openPreferences();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        });

        // Touchscreens, and keyboard navigation of the panel.
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._onAction();
            return Clutter.EVENT_STOP;
        });
        this.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol !== Clutter.KEY_Return && symbol !== Clutter.KEY_KP_Enter &&
                symbol !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            this._onAction();
            return Clutter.EVENT_STOP;
        });

        for (const key of ['rules', 'default-device', 'undo-record']) {
            this._settingsIds.push(
                this._settings.connect(`changed::${key}`, () => this._refresh()));
        }

        this._updateUi();
        this._connectClient();
    }

    /* ---------------------------------------------------------- lifecycle */

    _addTimeout(intervalMs, callback) {
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            const result = callback();
            if (result === GLib.SOURCE_REMOVE)
                this._sourceIds.delete(id);
            return result;
        });
        this._sourceIds.add(id);
        return id;
    }

    _connectClient() {
        Engine.getClient(this._cancellable).then(client => {
            if (this._destroyed)
                return;
            this._client = client;
            this._clientIds.push(client.connect('device-added', (_c, device) => {
                this._watchDevice(device);
                this._queueRefresh();
            }));
            this._clientIds.push(client.connect('device-removed', (_c, device) => {
                this._unwatchDevice(device);
                this._queueRefresh();
            }));
            for (const device of client.get_devices())
                this._watchDevice(device);
            this._refresh();
        }).catch(e => {
            if (isCancelled(e))
                return;
            logError(e, 'Split Routing: cannot reach NetworkManager');
        });
    }

    _watchDevice(device) {
        if (this._deviceIds.has(device))
            return;
        this._deviceIds.set(device, [
            device.connect('state-changed', () => this._queueRefresh()),
            device.connect('notify::ip4-config', () => this._queueRefresh()),
            device.connect('notify::ip6-config', () => this._queueRefresh()),
        ]);
    }

    _unwatchDevice(device) {
        const ids = this._deviceIds.get(device);
        if (!ids)
            return;
        // NOT device.disconnect(id): NM.Device has its own disconnect() method,
        // which takes down the card. Always disconnect signals explicitly.
        for (const id of ids)
            GObject.signal_handler_disconnect(device, id);
        this._deviceIds.delete(device);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();

        for (const id of this._sourceIds)
            GLib.source_remove(id);
        this._sourceIds.clear();
        this._refreshId = 0;

        for (const id of this._settingsIds)
            GObject.signal_handler_disconnect(this._settings, id);
        this._settingsIds = [];

        if (this._client) {
            for (const id of this._clientIds)
                GObject.signal_handler_disconnect(this._client, id);
            for (const device of [...this._deviceIds.keys()])
                this._unwatchDevice(device);
        }
        this._clientIds = [];
        this._deviceIds.clear();
        this._client = null;
        // _settings is kept: every signal on it is disconnected above, and a
        // change that lands during teardown must still reach the undo record.
        // It is released with the indicator itself.

        super.destroy();
    }

    /* --------------------------------------------------------------- state */

    _readRules() {
        try {
            const rules = JSON.parse(this._settings.get_string('rules'));
            return Array.isArray(rules) ? rules : [];
        } catch (_e) {
            return [];
        }
    }

    _readRecord() {
        return Engine.parseRecord(this._settings.get_string('undo-record'));
    }

    // Deliberately not gated on _destroyed: if a change lands while the
    // extension is being disabled, the undo record still has to describe it,
    // or the change could never be undone from here again.
    _writeRecord(record) {
        this._settings?.set_string('undo-record', JSON.stringify(record));
    }

    // NetworkManager updates a device's runtime config slightly after reapply()
    // returns, so for a moment after a switch the routing table legitimately
    // does not match the record yet. Never call the record stale in that window.
    _inGracePeriod() {
        return GLib.get_monotonic_time() < this._graceUntil;
    }

    // Bounded, and only after this extension changed something. Not polling:
    // once the last one fires, nothing is scheduled again until the user acts.
    _scheduleSettleChecks() {
        for (const delay of SETTLE_MS) {
            this._addTimeout(delay, () => {
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _queueRefresh() {
        if (this._destroyed || this._refreshId)
            return;
        this._refreshId = this._addTimeout(REFRESH_DEBOUNCE_MS, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        if (this._destroyed || !this._client)
            return;

        const record = this._readRecord();
        const {state, missing} = Engine.inspectRecord(this._client, record);

        // Our changes are runtime-only, so a reboot or a reconnect wipes them
        // while the record survives in GSettings. Drop it once it stops
        // matching reality — the write comes back here with an empty record,
        // which cannot loop.
        if (state === 'direct' && record.devices.length) {
            if (this._busy || this._inGracePeriod()) {
                this._updateUi();
                return;
            }
            this._writeRecord(Engine.emptyRecord());
            return;
        }

        // Mid-switch, "partial" usually means NetworkManager has not caught up
        // yet rather than that something failed. Leave the display alone and
        // let the settle checks decide once the grace window has passed.
        if (state === 'partial' && this._inGracePeriod())
            return;

        const previous = this._state;
        this._state = state;
        this._updateUi();

        // Only for a switch that decayed on its own — a card that dropped, or
        // an external `nmcli device reapply`. A switch that failed while we
        // were making it is already reported by _run() in more detail.
        if (state === 'partial' && previous !== 'partial' &&
            !this._busy && !this._inGracePeriod())
            this._notifyPartial(missing);
    }

    _notifyPartial(missing) {
        const listed = missing.slice(0, 3).map(m => `${m.detail} on ${m.iface}`);
        if (missing.length > listed.length)
            listed.push(`and ${missing.length - listed.length} more`);
        Main.notify('Split Routing',
            `Part of the configuration is no longer in effect: ${listed.join(', ')}.`);
    }

    _updateUi() {
        const ui = STATE_UI[this._state] ?? STATE_UI['direct'];
        const hasRules = this._readRules().length > 0;

        this._icon.icon_name = ui.icon;

        if (this._busy) {
            this._label.text = '…';
            this.accessible_name =
                'Split Routing: asking NetworkManager to apply the change';
            return;
        }

        if (!hasRules && this._state === 'direct') {
            this._label.text = 'SET UP';
            this.accessible_name =
                'Split Routing: no routing rules yet. Click to open the settings.';
            return;
        }

        this._label.text = ui.label;
        this.accessible_name = `Split Routing: ${ui.status} Right click for settings.`;
    }

    /* -------------------------------------------------------------- action */

    // Extension.openPreferences() makes this exact D-Bus call and then throws
    // the result away, so when the Shell refuses — most often "Already showing
    // a prefs dialog", because a preferences window is open somewhere, perhaps
    // on another workspace — the menu item silently does nothing. Same call,
    // with the answer actually read.
    _openPreferences() {
        Gio.DBus.session.call(
            'org.gnome.Shell.Extensions',
            '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions',
            'OpenExtensionPrefs',
            new GLib.Variant('(ssa{sv})', [this._extension.uuid, '', {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    Main.notifyError('Split Routing',
                        `Cannot open the settings window: ${errorText(e)}`);
                }
            });
    }

    _onAction() {
        if (this._busy || !this._client)
            return;

        if (this._state === 'direct' && this._readRules().length === 0) {
            this._openPreferences();
            return;
        }

        this._busy = true;
        this._updateUi();
        // Fire and forget: _run() handles every outcome itself.
        this._run();
    }

    async _run() {
        const persist = record => this._writeRecord(record);
        let problems = [];
        this._graceUntil = GLib.get_monotonic_time() + GRACE_US;

        try {
            const record = this._readRecord();
            if (Engine.recordState(this._client, record) === 'direct') {
                ({problems} = await Engine.applySplit(this._client, {
                    rules: this._readRules(),
                    defaultDevice: this._settings.get_string('default-device'),
                }, persist, this._cancellable));
            } else {
                ({problems} = await Engine.revertSplit(
                    this._client, record, persist, this._cancellable));
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'Split Routing');
            Main.notifyError('Split Routing', errorText(e));
        } finally {
            this._graceUntil = GLib.get_monotonic_time() + GRACE_US;
            if (!this._destroyed) {
                this._busy = false;
                this._refresh();
                this._updateUi();
                this._scheduleSettleChecks();
            }
        }

        if (problems.length && !this._destroyed)
            Main.notify('Split Routing', problems.join('\n'));
    }
});

export default class SplitRoutingExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
