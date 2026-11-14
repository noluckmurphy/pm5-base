// PM5Native: a fourth transport for when the page runs inside the Android TV
// app (android/), which owns the Bluetooth link itself because Android
// WebView has no Web Bluetooth. The app forwards raw PM5 notification bytes
// into the page and this class decodes them with PM5's own parsers, so the
// byte layouts stay in one place (pm5-ble.js).
//
// Contract with the app (see android/.../MainActivity.kt):
//   page -> app: window.PM5Android.connect() / .disconnect() / .isConnected()
//   app -> page: window.pm5native.onState(state, infoJson)
//                  state = 'scanning' | 'connecting' | 'connected' | 'disconnected' | 'error'
//                window.pm5native.onPacket(charHex, base64Bytes)
//                  charHex = 'ce060080' style short id of the characteristic
//
// Requires pm5-ble.js to be loaded first.

class PM5Native extends PM5 {

    static MESSAGE_EVENTS = ['multiplexed-information'];

    static available() {
        return typeof window !== 'undefined' && !!window.PM5Android;
    }

    // Plain characteristic -> PM5 handler, for any non-multiplexed
    // notifications the app chooses to forward.
    static _directHandlers = {
        ce060031: '_cbGeneralStatus',
        ce060032: '_cbAdditionalStatus',
        ce060033: '_cbAdditionalStatus2',
        ce060035: '_cbStrokeData',
        ce060036: '_cbAdditionalStrokeData',
        ce060037: '_cbSplitIntervalData',
        ce060038: '_cbAdditionalSplitIntervalData',
        ce060039: '_cbEndOfWorkoutSummaryData',
        ce06003a: '_cbAdditionalEndOfWorkoutSummaryData',
        ce06003b: '_cbHeartRateBeltInformation',
        ce06003c: '_cbAdditionalEndOfWorkoutSummaryData2',
    };

    constructor({ bridge } = {}) {
        super();
        this._bridge = bridge ?? (typeof window !== 'undefined' ? window.PM5Android : null);
        this._connected = false;
        if (typeof window !== 'undefined') window.pm5native = this;
    }

    // Data events are pushed by the app, so listening needs no GATT setup.
    addEventListener(type, callback) {
        EventTarget.prototype.addEventListener.call(this, type, callback);
    }
    removeEventListener(type, callback) {
        EventTarget.prototype.removeEventListener.call(this, type, callback);
        return Promise.resolve();
    }

    connect() {
        if (!this._bridge) return Promise.reject(new Error('Not running inside the TV app'));
        this._dispatchLifecycle('connecting');
        this._bridge.connect();
        // Resolves straight away: the app keeps scanning/reconnecting on its
        // own and reports progress through onState().
        return Promise.resolve();
    }

    disconnect() {
        this._bridge?.disconnect();
    }

    connected() {
        return this._connected;
    }

    onState(state, infoJson) {
        let info = {};
        try { info = infoJson ? JSON.parse(infoJson) : {}; } catch { /* ignore */ }
        const wasConnected = this._connected;
        this._connected = state === 'connected';
        if (state === 'connected' && !wasConnected) this._dispatchLifecycle('connected', info);
        else if (state !== 'connected' && wasConnected) this._dispatchLifecycle('disconnected');
        const ev = new Event('native-state');
        ev.data = { state, ...info };
        this.dispatchEvent(ev);
    }

    onPacket(charHex, base64) {
        const view = PM5Native.toDataView(base64);
        const e = { target: { value: view } };
        const id = String(charHex).toLowerCase().slice(0, 8);
        if (id === 'ce060080') {
            this._cbMultiplexedInformation(e);
        } else {
            const h = PM5Native._directHandlers[id];
            if (h) this[h](e, false);
        }
    }

    static toDataView(base64) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new DataView(bytes.buffer);
    }
}

if (typeof module !== 'undefined') {
    module.exports = { PM5Native };
}
