/* Split Routing — routing engine.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Every routing change goes through NetworkManager over D-Bus (libnm): no
 * sudo, no shell scripts, no subprocesses. Changes are made to the RUNNING
 * connection via Device.reapply(), never to a saved profile, so a reboot or a
 * NetworkManager restart returns the machine to its normal routing on its own.
 *
 * This module is imported by BOTH the Shell process and the preferences
 * process, so it must never import St/Clutter/Meta/Shell nor Gtk/Adw.
 *
 * Nothing here knows about any specific network: cards come from
 * NetworkManager, subnets come from the user, gateways are detected per card.
 */

import NM from 'gi://NM';

// <bits/socket.h> on Linux. GLib does not expose AF_* constants.
export const AF_INET = 2;
export const AF_INET6 = 10;

const RECORD_VERSION = 1;

/* ------------------------------------------------------------------ client */

export function getClient(cancellable = null) {
    return new Promise((resolve, reject) => {
        NM.Client.new_async(cancellable, (_obj, res) => {
            try {
                resolve(NM.Client.new_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/* ------------------------------------------------------------- CIDR values */

/**
 * Parse and canonicalise a subnet.
 *
 * Validation is delegated to libnm itself (NM.IPRoute.new throws on a bad
 * address or a bad prefix), so what this accepts is exactly what NetworkManager
 * will later accept. A bare address with no "/" means a host route.
 *
 * @param {string} text - user input, e.g. "10.0.0.0/8" or "fd00::/48"
 * @returns {?{family: number, dest: string, prefix: number}} null if invalid
 */
export function parseCidr(text) {
    const raw = String(text ?? '').trim();
    if (!raw)
        return null;

    const slash = raw.lastIndexOf('/');
    const addr = (slash < 0 ? raw : raw.slice(0, slash)).trim();
    const family = addr.includes(':') ? AF_INET6 : AF_INET;
    const prefixText = slash < 0
        ? String(family === AF_INET ? 32 : 128)
        : raw.slice(slash + 1).trim();

    if (!/^\d+$/.test(prefixText))
        return null;

    try {
        const route = NM.IPRoute.new(family, addr, parseInt(prefixText, 10), null, -1);
        return {family, dest: route.get_dest(), prefix: route.get_prefix()};
    } catch (_e) {
        return null;
    }
}

export function formatCidr(spec) {
    return `${spec.dest}/${spec.prefix}`;
}

function sameSpec(a, b) {
    return a.family === b.family && a.dest === b.dest && a.prefix === b.prefix;
}

/* --------------------------------------------------------------- read-only */

export function deviceByIface(client, iface) {
    if (!iface)
        return null;
    return client.get_devices().find(d => d.get_iface() === iface) ?? null;
}

export function isConnected(device) {
    return !!device && device.get_state() === NM.DeviceState.ACTIVATED;
}

/**
 * Whether the card can be unplugged.
 *
 * The kernel's own device path answers this: anything sitting on a USB bus is
 * removable, anything else is inside the machine. Note what is deliberately
 * NOT claimed — "onboard". Telling a soldered chip from a card in a PCIe slot
 * needs a firmware index that plenty of machines simply do not publish, so a
 * "built-in" label would quietly be wrong on those.
 *
 * @param {NM.Device} device - the card
 * @returns {'USB'|'Internal'} how it is attached
 */
function busLabel(device) {
    const udi = device.get_udi() ?? '';
    const path = device.get_path() ?? '';
    return /\/usb\d/.test(udi) || /-usb-/.test(path) ? 'USB' : 'Internal';
}

/** A short word for why a card is not usable, for the settings list. */
function stateLabel(device) {
    // An unplugged cable and a disabled card both read as unavailable, and
    // only one of them is fixed by walking over to the desk.
    if (device instanceof NM.DeviceEthernet && !device.get_carrier() &&
        device.get_state() !== NM.DeviceState.ACTIVATED)
        return 'no cable';

    switch (device.get_state()) {
    case NM.DeviceState.ACTIVATED:
        return 'connected';
    case NM.DeviceState.UNAVAILABLE:
        return 'unavailable';       // no carrier, or the radio is off
    case NM.DeviceState.DISCONNECTED:
        return 'disconnected';
    case NM.DeviceState.DEACTIVATING:
        return 'disconnecting';
    case NM.DeviceState.FAILED:
        return 'failed';
    case NM.DeviceState.UNMANAGED:
        return 'unmanaged';
    case NM.DeviceState.UNKNOWN:
        return 'unknown';
    default:
        return 'connecting';        // PREPARE through SECONDARIES
    }
}

/**
 * Managed Ethernet/Wi-Fi cards — the meaningful routing targets.
 *
 * Cards that are down are included, and said to be down. Leaving them out
 * would mean a rule could not be pointed at a card whose cable is unplugged,
 * or edited after its Wi-Fi dropped.
 *
 * @param {NM.Client} client - libnm client
 * @returns {object[]} connected cards first, then the rest, each name-sorted
 */
export function listCards(client) {
    const cards = [];
    for (const device of client.get_devices()) {
        const type = device.get_device_type();
        if (type !== NM.DeviceType.ETHERNET && type !== NM.DeviceType.WIFI)
            continue;
        if (!device.get_managed())
            continue;
        cards.push({
            iface: device.get_iface(),
            kind: type === NM.DeviceType.WIFI ? 'Wi-Fi' : 'Ethernet',
            connected: isConnected(device),
            status: stateLabel(device),
            bus: busLabel(device),
            // "Intel Wi-Fi", "Apple iPhone 5/…/XR". Not get_product(), which
            // NetworkManager leaves empty for plenty of cards.
            description: device.get_description() ?? '',
            gateway4: detectGateway(device, AF_INET),
            gateway6: detectGateway(device, AF_INET6),
        });
    }
    cards.sort((a, b) =>
        Number(b.connected) - Number(a.connected) || a.iface.localeCompare(b.iface));
    return cards;
}

function runtimeConfig(device, family) {
    return family === AF_INET ? device.get_ip4_config() : device.get_ip6_config();
}

/**
 * The card's own gateway, else its DHCP router.
 *
 * The fallback matters: once a card is marked never-default NetworkManager
 * drops its gateway from the runtime config, so on a second apply the direct
 * gateway is gone while the DHCP lease still names the router.
 *
 * @param {NM.Device} device - the card
 * @param {number} family - AF_INET or AF_INET6
 * @returns {?string} gateway address, or null for an on-link route
 */
export function detectGateway(device, family) {
    const gateway = runtimeConfig(device, family)?.get_gateway();
    if (gateway)
        return gateway;

    if (family === AF_INET) {
        const routers = device.get_dhcp4_config()?.get_options()?.['routers'];
        if (routers)
            return routers.trim().split(/\s+/)[0];
    }
    return null;
}

/** Is this subnet currently routed out this card? (kernel truth, via libnm) */
export function hasRuntimeRoute(device, spec) {
    const config = runtimeConfig(device, spec.family);
    if (!config)
        return false;
    return config.get_routes().some(
        r => r.get_dest() === spec.dest && r.get_prefix() === spec.prefix);
}

/** Does this card currently carry a default route for this family? */
export function hasDefaultRoute(device, family) {
    const config = runtimeConfig(device, family);
    if (!config)
        return false;
    const zero = family === AF_INET ? '0.0.0.0' : '::';
    return config.get_routes().some(
        r => r.get_prefix() === 0 && r.get_dest() === zero);
}

/* ------------------------------------------------------------- undo record */
//
// The record is the only source of truth about what WE changed. It is written
// after every successful reapply, so a failure halfway through still leaves an
// exact undo list. Because our changes are runtime-only, the record can also
// go stale (reboot, reconnect, `nmcli device reapply`) — recordState() detects
// that by checking the runtime routing table, and the caller then clears it.

export function emptyRecord() {
    return {version: RECORD_VERSION, devices: []};
}

/** Parse a stored record defensively; anything malformed becomes empty. */
export function parseRecord(text) {
    let raw;
    try {
        raw = JSON.parse(text || '{}');
    } catch (_e) {
        return emptyRecord();
    }
    if (!raw || raw.version !== RECORD_VERSION || !Array.isArray(raw.devices))
        return emptyRecord();

    const devices = [];
    for (const entry of raw.devices) {
        if (!entry || typeof entry.iface !== 'string')
            continue;
        const routes = (Array.isArray(entry.routes) ? entry.routes : []).filter(
            r => r && (r.family === AF_INET || r.family === AF_INET6) &&
                typeof r.dest === 'string' && Number.isInteger(r.prefix));
        const defaults = (Array.isArray(entry.defaults) ? entry.defaults : []).filter(
            d => d && (d.family === AF_INET || d.family === AF_INET6) &&
                typeof d.prev === 'boolean' && typeof d.want === 'boolean');
        if (routes.length || defaults.length)
            devices.push({iface: entry.iface, routes, defaults});
    }
    return {version: RECORD_VERSION, devices};
}

/**
 * What the machine's routing actually looks like right now.
 *
 * Only verifiable claims are counted. A recorded `never-default = true` is
 * verifiable (the card must have no default route); `never-default = false` is
 * not, because a card can legitimately have no default route of its own.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} record - the undo record
 * @returns {'direct'|'partial'|'split'} observed state
 */
export function inspectRecord(client, record) {
    let expected = 0;
    let live = 0;
    const missing = [];

    for (const entry of record.devices) {
        const device = deviceByIface(client, entry.iface);

        for (const spec of entry.routes) {
            expected++;
            if (device && hasRuntimeRoute(device, spec))
                live++;
            else
                missing.push({iface: entry.iface, detail: formatCidr(spec)});
        }

        for (const def of entry.defaults) {
            if (!def.want)
                continue;
            expected++;
            if (device && !hasDefaultRoute(device, def.family))
                live++;
            else
                missing.push({iface: entry.iface, detail: `IPv${def.family === AF_INET ? '4' : '6'} default route`});
        }
    }

    let state;
    if (expected === 0 || live === 0)
        state = 'direct';
    else
        state = live === expected ? 'split' : 'partial';

    return {state, expected, live, missing};
}

export function recordState(client, record) {
    return inspectRecord(client, record).state;
}

/* ------------------------------------------------------------ apply/revert */

function getAppliedConnection(device, cancellable) {
    return new Promise((resolve, reject) => {
        device.get_applied_connection_async(0, cancellable, (_d, res) => {
            try {
                const [connection, versionId] = device.get_applied_connection_finish(res);
                resolve({connection, versionId});
            } catch (e) {
                reject(e);
            }
        });
    });
}

function reapply(device, connection, versionId, cancellable) {
    return new Promise((resolve, reject) => {
        device.reapply_async(connection, versionId, 0, cancellable, (_d, res) => {
            try {
                resolve(device.reapply_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function ipSetting(connection, family) {
    const setting = family === AF_INET
        ? connection.get_setting_ip4_config()
        : connection.get_setting_ip6_config();
    if (!setting)
        return null;
    const method = setting.get_method();
    if (method === 'disabled' || method === 'ignore')
        return null;
    return setting;
}

function findRouteIndex(setting, spec) {
    for (let i = 0; i < setting.get_num_routes(); i++) {
        const route = setting.get_route(i);
        if (route.get_dest() === spec.dest && route.get_prefix() === spec.prefix)
            return i;
    }
    return -1;
}

function errorText(e) {
    return e?.message ?? String(e);
}

function planFor(plans, iface) {
    let plan = plans.get(iface);
    if (!plan) {
        plan = {routes: [], defaults: []};
        plans.set(iface, plan);
    }
    return plan;
}

/**
 * Switch on split routing.
 *
 * `persist` is called with the growing undo record after every device that was
 * successfully changed, so an interruption never leaves an unrecorded change.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} config - {rules, defaultDevice} from the settings UI
 * @param {Function} persist - called with the undo record after each change
 * @param {?Gio.Cancellable} cancellable - cancels in-flight D-Bus calls
 * @returns {Promise<{problems: string[]}>} non-fatal problems worth reporting
 */
export async function applySplit(client, {rules, defaultDevice}, persist, cancellable = null) {
    const problems = [];
    const plans = new Map();

    for (const rule of rules ?? []) {
        const spec = parseCidr(rule.subnet);
        if (!spec) {
            problems.push(`Ignored invalid subnet "${rule.subnet}".`);
            continue;
        }
        const device = deviceByIface(client, rule.device);
        if (!isConnected(device)) {
            problems.push(`Skipped ${formatCidr(spec)}: ${rule.device} is not connected.`);
            continue;
        }
        planFor(plans, rule.device).routes.push(spec);
    }

    // Default-route ownership. Never touched unless the chosen card is up —
    // otherwise every card would be marked never-default and the machine would
    // be left with no default route at all.
    if (defaultDevice) {
        const connected = listCards(client).filter(c => c.connected);
        if (!connected.some(c => c.iface === defaultDevice)) {
            problems.push(`Default-route card ${defaultDevice} is not connected: the default route was left untouched.`);
        } else {
            for (const card of connected) {
                for (const family of [AF_INET, AF_INET6])
                    planFor(plans, card.iface).defaults.push({family, want: card.iface !== defaultDevice});
            }
        }
    }

    const record = emptyRecord();

    for (const [iface, plan] of plans) {
        const device = deviceByIface(client, iface);
        if (!isConnected(device))
            continue;

        let applied;
        try {
            applied = await getAppliedConnection(device, cancellable);
        } catch (e) {
            problems.push(`${iface}: cannot read the running configuration (${errorText(e)}).`);
            continue;
        }

        const {connection, versionId} = applied;
        const entry = {iface, routes: [], defaults: []};

        for (const spec of plan.routes) {
            const setting = ipSetting(connection, spec.family);
            if (!setting) {
                problems.push(`${iface}: ${formatCidr(spec)} skipped, that address family is not configured on this card.`);
                continue;
            }
            // A route the user already has is left alone — and, crucially, not
            // recorded, so reverting will not delete their own configuration.
            if (findRouteIndex(setting, spec) >= 0)
                continue;
            setting.add_route(NM.IPRoute.new(
                spec.family, spec.dest, spec.prefix, detectGateway(device, spec.family), -1));
            entry.routes.push(spec);
        }

        for (const def of plan.defaults) {
            const setting = ipSetting(connection, def.family);
            if (!setting)
                continue;
            const prev = setting.get_never_default();
            if (prev === def.want)
                continue;
            setting.set_property('never-default', def.want);
            entry.defaults.push({family: def.family, prev, want: def.want});
        }

        if (!entry.routes.length && !entry.defaults.length)
            continue;

        try {
            await reapply(device, connection, versionId, cancellable);
        } catch (e) {
            // Nothing was applied to this card, so nothing is recorded for it.
            problems.push(`${iface}: ${errorText(e)}`);
            continue;
        }

        record.devices.push(entry);
        persist(record);
    }

    if (!record.devices.length)
        persist(record);

    return {problems};
}

async function revertEntry(client, entry, cancellable) {
    const device = deviceByIface(client, entry.iface);
    // A card that is gone or down has already dropped our runtime changes.
    if (!isConnected(device))
        return;

    const {connection, versionId} = await getAppliedConnection(device, cancellable);
    let changed = false;

    for (const spec of entry.routes) {
        const setting = ipSetting(connection, spec.family);
        if (!setting)
            continue;
        const index = findRouteIndex(setting, spec);
        if (index >= 0) {
            setting.remove_route(index);
            changed = true;
        }
    }

    for (const def of entry.defaults) {
        const setting = ipSetting(connection, def.family);
        if (!setting)
            continue;
        if (setting.get_never_default() !== def.prev) {
            setting.set_property('never-default', def.prev);
            changed = true;
        }
    }

    if (changed)
        await reapply(device, connection, versionId, cancellable);
}

/**
 * Undo exactly what was applied — no more.
 *
 * Routes the user already had are not in the record, so they survive; a card's
 * previous never-default value is restored rather than assumed to be false.
 *
 * @param {NM.Client} client - libnm client
 * @param {object} record - the undo record
 * @param {Function} persist - called with what is still outstanding
 * @param {?Gio.Cancellable} cancellable - cancels in-flight D-Bus calls
 * @returns {Promise<{problems: string[]}>} cards that could not be reverted
 */
export async function revertSplit(client, record, persist, cancellable = null) {
    const problems = [];
    const pending = [...record.devices];
    const stuck = [];

    while (pending.length) {
        const entry = pending.shift();
        try {
            await revertEntry(client, entry, cancellable);
        } catch (e) {
            problems.push(`${entry.iface}: ${errorText(e)}`);
            stuck.push(entry);
        }
        persist({version: RECORD_VERSION, devices: [...stuck, ...pending]});
    }

    return {problems};
}

/** Human-readable dry run, used by the preferences window. */
export function describePlan(client, {rules, defaultDevice}) {
    const lines = [];

    for (const rule of rules ?? []) {
        const spec = parseCidr(rule.subnet);
        if (!spec) {
            lines.push(`${rule.subnet || '(empty)'} — invalid, will be ignored`);
            continue;
        }
        const device = deviceByIface(client, rule.device);
        if (!isConnected(device)) {
            lines.push(`${formatCidr(spec)} — ${rule.device} is not connected, will be skipped`);
            continue;
        }
        const gateway = detectGateway(device, spec.family);
        lines.push(gateway
            ? `${formatCidr(spec)} → via ${gateway} on ${rule.device}`
            : `${formatCidr(spec)} → on-link on ${rule.device}`);
    }

    if (defaultDevice) {
        const connected = listCards(client).filter(c => c.connected);
        if (!connected.some(c => c.iface === defaultDevice)) {
            lines.push(`default route — ${defaultDevice} is not connected, will be left untouched`);
        } else {
            const others = connected.filter(c => c.iface !== defaultDevice).map(c => c.iface);
            lines.push(others.length
                ? `default route → ${defaultDevice} (never-default on ${others.join(', ')}, IPv4 and IPv6)`
                : `default route → ${defaultDevice} (the only connected card)`);
        }
    } else {
        lines.push('default route — left untouched');
    }

    return lines;
}
