// Engine tests against a simulated NetworkManager: real NM setting/route
// objects, fake devices that record reapply() and update their runtime config
// the way NM would. Touches nothing on the machine.
import NM from 'gi://NM';
import * as Engine from '../lib/engine.js';

let failures = 0;
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok)
        failures++;
    print(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got      ${a}\n        expected ${e}`}`);
};

function makeConnection({routes4 = [], neverDefault4 = false, routes6 = [], neverDefault6 = false} = {}) {
    const conn = NM.SimpleConnection.new();
    const s4 = NM.SettingIP4Config.new();
    s4.set_property('method', 'auto');
    s4.set_property('never-default', neverDefault4);
    for (const r of routes4)
        s4.add_route(NM.IPRoute.new(Engine.AF_INET, r.dest, r.prefix, r.gw ?? null, -1));
    conn.add_setting(s4);
    const s6 = NM.SettingIP6Config.new();
    s6.set_property('method', 'auto');
    s6.set_property('never-default', neverDefault6);
    for (const r of routes6)
        s6.add_route(NM.IPRoute.new(Engine.AF_INET6, r.dest, r.prefix, r.gw ?? null, -1));
    conn.add_setting(s6);
    return conn;
}

function routesOf(conn, family) {
    const s = family === Engine.AF_INET ? conn.get_setting_ip4_config() : conn.get_setting_ip6_config();
    const out = [];
    for (let i = 0; i < s.get_num_routes(); i++) {
        const r = s.get_route(i);
        out.push(`${r.get_dest()}/${r.get_prefix()}`);
    }
    return out;
}

class FakeDevice {
    constructor(iface, connection, {gateway4 = '198.51.100.1', gateway6 = 'fe80::1', failReapply = false} = {}) {
        this.iface = iface;
        this.connection = connection;
        this.gateway4 = gateway4;
        this.gateway6 = gateway6;
        this.failReapply = failReapply;
        this.reapplyCount = 0;
        this._syncRuntime();
    }

    // NM recomputes the runtime config from the applied connection.
    _syncRuntime() {
        const build = (family, gateway) => {
            const s = family === Engine.AF_INET
                ? this.connection.get_setting_ip4_config()
                : this.connection.get_setting_ip6_config();
            const routes = [];
            for (let i = 0; i < s.get_num_routes(); i++)
                routes.push(s.get_route(i));
            if (!s.get_never_default() && gateway) {
                routes.push(NM.IPRoute.new(family,
                    family === Engine.AF_INET ? '0.0.0.0' : '::', 0, gateway, -1));
            }
            return {
                get_gateway: () => (s.get_never_default() ? null : gateway),
                get_routes: () => routes,
            };
        };
        this._ip4 = build(Engine.AF_INET, this.gateway4);
        this._ip6 = build(Engine.AF_INET6, this.gateway6);
    }

    get_iface() { return this.iface; }
    // listCards() reads these to label the card in the settings list.
    get_udi() { return `/sys/devices/pci0000:00/0000:00:1f.6/net/${this.iface}`; }
    get_path() { return 'pci-0000:00:1f.6'; }
    get_description() { return `Simulated ${this.iface}`; }
    get_state() { return NM.DeviceState.ACTIVATED; }
    get_managed() { return true; }
    get_device_type() { return NM.DeviceType.ETHERNET; }
    get_ip4_config() { return this._ip4; }
    get_ip6_config() { return this._ip6; }
    get_dhcp4_config() { return {get_options: () => ({routers: this.gateway4})}; }

    get_applied_connection_async(_flags, _cancellable, callback) { callback(this, 'res'); }
    get_applied_connection_finish(_res) { return [this.connection, 7]; }

    reapply_async(connection, _versionId, _flags, _cancellable, callback) {
        this._pending = connection;
        callback(this, 'res');
    }

    reapply_finish(_res) {
        if (this.failReapply)
            throw new Error('simulated reapply failure');
        this.reapplyCount++;
        this.connection = this._pending;
        this._syncRuntime();
        return true;
    }
}

const fakeClient = devices => ({get_devices: () => devices});

/* ------------------------------------------------------------ parseCidr */

check('parseCidr IPv4', Engine.parseCidr('10.0.0.0/8'), {family: 2, dest: '10.0.0.0', prefix: 8});
check('parseCidr IPv6 is canonicalised', Engine.parseCidr('FD00::/48'), {family: 10, dest: 'fd00::', prefix: 48});
check('parseCidr bare host address', Engine.parseCidr('192.168.5.7'), {family: 2, dest: '192.168.5.7', prefix: 32});
check('parseCidr rejects bad prefix', Engine.parseCidr('10.0.0.0/99'), null);
check('parseCidr rejects bad address', Engine.parseCidr('10.0.0.999/8'), null);
check('parseCidr rejects words', Engine.parseCidr('the internet'), null);
check('parseCidr rejects empty', Engine.parseCidr('   '), null);
check('parseCidr rejects negative prefix', Engine.parseCidr('10.0.0.0/-1'), null);

/* --------------------------------------------------------- parseRecord */

check('parseRecord of garbage', Engine.parseRecord('not json'), {version: 1, devices: []});
check('parseRecord of a future version', Engine.parseRecord('{"version":99,"devices":[]}'), {version: 1, devices: []});
check('parseRecord drops malformed entries',
    Engine.parseRecord('{"version":1,"devices":[{"iface":"eth0","routes":[{"family":2,"dest":"10.0.0.0","prefix":"eight"}],"defaults":[]}]}'),
    {version: 1, devices: []});

/* ------------------------------------------------- apply keeps user data */

print('\n--- apply/revert around a route the user already had ---');
{
    // eth0 already carries the user's own 10.0.0.0/8 route and is never-default.
    const eth0 = new FakeDevice('eth0', makeConnection({
        routes4: [{dest: '10.0.0.0', prefix: 8, gw: '198.51.100.1'}],
        neverDefault4: true,
        neverDefault6: true,
    }), {gateway4: '198.51.100.1'});
    const wlan0 = new FakeDevice('wlan0', makeConnection(), {gateway4: '203.0.113.1', gateway6: 'fe80::2'});
    const client = fakeClient([eth0, wlan0]);

    let record = Engine.emptyRecord();
    const persist = r => {
        record = JSON.parse(JSON.stringify(r));
    };

    const {problems} = await Engine.applySplit(client, {
        rules: [
            {subnet: '10.0.0.0/8', device: 'eth0'},      // already present
            {subnet: '172.16.0.0/12', device: 'eth0'},   // new
            {subnet: 'fd00::/48', device: 'wlan0'},      // new, IPv6
            {subnet: 'nonsense', device: 'eth0'},        // invalid
            {subnet: '10.9.0.0/16', device: 'ppp0'},     // missing card
        ],
        defaultDevice: 'eth0',
    }, persist);

    check('problems reported', problems, [
        'Ignored invalid subnet "nonsense".',
        'Skipped 10.9.0.0/16: ppp0 is not connected.',
    ]);
    check('eth0 routes after apply', routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8', '172.16.0.0/12']);
    check('wlan0 IPv6 routes after apply', routesOf(wlan0.connection, Engine.AF_INET6), ['fd00::/48']);
    check('eth0 never-default is now false (it owns the default route)',
        eth0.connection.get_setting_ip4_config().get_never_default(), false);
    check('wlan0 never-default v4 is now true',
        wlan0.connection.get_setting_ip4_config().get_never_default(), true);
    check('wlan0 never-default v6 is now true',
        wlan0.connection.get_setting_ip6_config().get_never_default(), true);

    check('record only claims the route we added on eth0',
        record.devices.find(d => d.iface === 'eth0').routes,
        [{family: 2, dest: '172.16.0.0', prefix: 12}]);
    check('record remembers eth0 never-default was true',
        record.devices.find(d => d.iface === 'eth0').defaults,
        [{family: 2, prev: true, want: false}, {family: 10, prev: true, want: false}]);

    check('state is parallel', Engine.recordState(client, record), 'split');

    const revert = await Engine.revertSplit(client, record, persist);
    check('revert had no problems', revert.problems, []);
    check("the user's own route survived", routesOf(eth0.connection, Engine.AF_INET), ['10.0.0.0/8']);
    check('our IPv6 route is gone', routesOf(wlan0.connection, Engine.AF_INET6), []);
    check('eth0 never-default restored to true',
        eth0.connection.get_setting_ip4_config().get_never_default(), true);
    check('wlan0 never-default restored to false',
        wlan0.connection.get_setting_ip4_config().get_never_default(), false);
    check('record is empty again', record.devices, []);
    check('state is default', Engine.recordState(client, record), 'direct');
}

/* ------------------------------------------------- a failing reapply */

print('\n--- a card whose reapply fails ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const wlan0 = new FakeDevice('wlan0', makeConnection(), {failReapply: true});
    const client = fakeClient([eth0, wlan0]);

    let record = Engine.emptyRecord();
    const persist = r => {
        record = JSON.parse(JSON.stringify(r));
    };

    const {problems} = await Engine.applySplit(client, {
        rules: [
            {subnet: '172.16.0.0/12', device: 'eth0'},
            {subnet: '10.0.0.0/8', device: 'wlan0'},
        ],
        defaultDevice: '',
    }, persist);

    check('the failure is reported', problems, ['wlan0: simulated reapply failure']);
    check('only the card that really changed is recorded',
        record.devices.map(d => d.iface), ['eth0']);
    check('state is parallel (everything recorded is live)',
        Engine.recordState(client, record), 'split');
}

/* ------------------------------------------------- a stale record */

print('\n--- a record that no longer matches reality (reboot, reconnect) ---');
{
    const eth0 = new FakeDevice('eth0', makeConnection());
    const client = fakeClient([eth0]);
    const stale = {version: 1, devices: [{iface: 'eth0', routes: [{family: 2, dest: '172.16.0.0', prefix: 12}], defaults: []}]};
    check('stale record reads as default', Engine.recordState(client, stale), 'direct');
    check('reverting a stale record is a no-op',
        (await Engine.revertSplit(client, stale, () => {})).problems, []);

    const mixed = {version: 1, devices: [{
        iface: 'eth0',
        routes: [{family: 2, dest: '172.16.0.0', prefix: 12}],
        defaults: [{family: 2, prev: false, want: true}],
    }]};
    // eth0 has no default route only if never-default is set; it is not, so the
    // "defaults" half is not live while the route half is also not live.
    eth0.connection.get_setting_ip4_config().add_route(
        NM.IPRoute.new(Engine.AF_INET, '172.16.0.0', 12, null, -1));
    eth0._syncRuntime();
    check('half-live record reads as partial', Engine.recordState(client, mixed), 'partial');
    check('inspectRecord names exactly what is missing',
        Engine.inspectRecord(client, mixed).missing,
        [{iface: 'eth0', detail: 'IPv4 default route'}]);

    const gone = {version: 1, devices: [{
        iface: 'eth0',
        routes: [{family: 2, dest: '10.1.0.0', prefix: 16}, {family: 10, dest: 'fd00::', prefix: 48}],
        defaults: [],
    }]};
    check('missing lists every absent route with its card',
        Engine.inspectRecord(client, gone).missing,
        [{iface: 'eth0', detail: '10.1.0.0/16'}, {iface: 'eth0', detail: 'fd00::/48'}]);
    check('a record with nothing live is default, not partial',
        Engine.inspectRecord(client, gone).state, 'direct');
}

print(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
