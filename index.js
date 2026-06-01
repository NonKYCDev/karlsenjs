// ---------------------------------------------------------------------------
// karlsenjs
//
// A drop-in shim that exposes the Karlsen (rusty-karlsen) WASM `RpcClient`
// through the same `Daemon` / `.request("getXRequest", params)` surface as
// `kaspajs` / `keryxjs` / `htnjs`, so a `kaspa-clone-api`-style indexer can
// talk to a Karlsen node over wRPC by adding a single `config.daemons`
// entry — no changes to the consuming app.
//
// Ported from keryxjs (2026-05-22). Only the WASM bundle name, the env var,
// and the default network differ; the request/normalize/method-mapping logic
// is identical because Karlsen is a rusty-kaspa fork with the same RPC surface
// (verified against rpc/wrpc/wasm/src/client.rs — GetInfo, GetBlockDagInfo,
//  GetBlocks, GetBalanceByAddress, GetUtxosByAddresses, GetVirtualChainFromBlock).
// ---------------------------------------------------------------------------

"use strict";

// ---------------------------------------------------------------------------
// WebSocket polyfill.
//
// The Karlsen WASM nodejs client uses the WHATWG `WebSocket` global. Node
// only ships a built-in global WebSocket from v21+, and NonKYC's stack runs
// on Node 16, so provide one from the `websocket` package when it's missing.
// (On newer Node this is a no-op.)
// ---------------------------------------------------------------------------

if (typeof globalThis.WebSocket === "undefined") {
    try {
        globalThis.WebSocket = require("websocket").w3cwebsocket;
    } catch (_) {
        // If the WASM bundle ships its own shim, this is harmless.
    }
}

// ---------------------------------------------------------------------------
// Web Crypto polyfill.
//
// The WASM client (via ahash -> getrandom) needs `crypto.getRandomValues` at
// RpcClient *construction* time. Node only exposes a global `crypto` from
// ~v19+, so on Node 16/18 it is missing and `new RpcClient(...)` aborts with a
// bare `RuntimeError: unreachable` (the underlying panic is
// "getrandom::fill() failed"). Supply it from node:crypto's webcrypto when
// absent. Must run before the WASM module is loaded/used below.
// ---------------------------------------------------------------------------

if (typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.getRandomValues !== "function") {
    try {
        globalThis.crypto = require("crypto").webcrypto;
    } catch (_) {
        // Pre-webcrypto Node (<15): nothing to do; getrandom will fail loudly.
    }
}

// ---------------------------------------------------------------------------
// Load the Karlsen WASM Node bundle.
//
// rusty-karlsen's WASM crate is `karlsen-wasm`; its Node build lands at
// `wasm/nodejs/karlsen/` and exposes `karlsen.js`. Provide it either:
//   * bundled inside this package at ./nodejs/karlsen/, or
//   * via KARLSEN_WASM_PATH pointing at that directory (or the .js file).
// ---------------------------------------------------------------------------

function loadWasm() {
    const tried = [];
    const candidates = [];
    if (process.env.KARLSEN_WASM_PATH) candidates.push(process.env.KARLSEN_WASM_PATH);
    candidates.push("./nodejs/karlsen", "./nodejs/kaspa", "karlsen-wasm");

    for (const c of candidates) {
        try {
            return require(c);
        } catch (err) {
            tried.push(c + " (" + ((err && err.code) || (err && err.message) || err) + ")");
        }
    }

    throw new Error(
        "karlsenjs: could not load the Karlsen WASM bundle. Tried: " +
        tried.join(", ") + ". Set KARLSEN_WASM_PATH to rusty-karlsen's " +
        "wasm/nodejs/karlsen directory (the Node target of the wasm build)."
    );
}

const karlsen = loadWasm();

const RpcClient       = karlsen.RpcClient;
const Encoding        = karlsen.Encoding;
const ConnectStrategy = karlsen.ConnectStrategy;

if (typeof RpcClient !== "function") {
    throw new Error(
        "karlsenjs: the loaded WASM bundle does not export RpcClient — " +
        "is this actually the karlsen-wasm Node build?"
    );
}

// ---------------------------------------------------------------------------
// Method name resolution.
//
// The kaspa-clone-api importer calls legacy gRPC-style names like
// "getInfoRequest". The WASM RpcClient uses the bare camelCase name
// ("getInfo"), so we strip a trailing "Request". One method was renamed
// upstream (VSPC -> getVirtualChainFromBlock); alias it explicitly.
//
// If a future karlsen-wasm build renames or reverts a method, add it here —
// every other RpcClient method is reachable verbatim with no entry needed.
// ---------------------------------------------------------------------------

const METHOD_ALIASES = {
    // name after "Request" is stripped : actual WASM RpcClient method
    getVirtualSelectedParentChainFromBlock: "getVirtualChainFromBlock",
};

function resolveMethod(method) {
    if (typeof method !== "string" || method.length === 0) {
        throw new Error("karlsenjs: method name must be a non-empty string");
    }
    let name = method;
    if (name.endsWith("Request")) {
        name = name.slice(0, name.length - "Request".length);
    }
    if (Object.prototype.hasOwnProperty.call(METHOD_ALIASES, name)) {
        name = METHOD_ALIASES[name];
    }
    return name;
}

// ---------------------------------------------------------------------------
// Response normalization.
//
// The WASM client returns BigInt for 64-bit numeric fields and Uint8Array
// for byte fields. The gRPC daemons (kaspajs/htnjs) return those as decimal
// strings and hex strings respectively, and downstream code (importer.js)
// does parseInt(...) / string ops on them. Round-trip through JSON with a
// replacer so the wire shape matches the other forks exactly.
// ---------------------------------------------------------------------------

function normalize(value) {
    return JSON.parse(
        JSON.stringify(value, function (key, v) {
            if (typeof v === "bigint") return v.toString();
            if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
            return v;
        })
    );
}

// ---------------------------------------------------------------------------
// toUrl — the importer passes "host:port"; the WASM client wants a ws URL.
// Accept both forms.
// ---------------------------------------------------------------------------

function toUrl(address) {
    if (typeof address !== "string") {
        throw new Error("karlsenjs: address must be a string");
    }
    if (address.startsWith("ws://") || address.startsWith("wss://")) {
        return address;
    }
    return "ws://" + address;
}

// ---------------------------------------------------------------------------
// Daemon
//
// Mirrors the kaspajs Daemon class:
//   new Daemon(address, onConnect)
//   await daemon.request(methodName, params)
//
// Also accepts an options object as the first argument:
//   new Daemon({ url, networkId, encoding }, onConnect)
// ---------------------------------------------------------------------------

class Daemon {

    constructor(address, onConnect) {

        let url, networkId, encoding;

        if (typeof address === "object" && address !== null) {
            url       = toUrl(address.url || address.address);
            networkId = address.networkId || process.env.KARLSEN_NETWORK_ID || "mainnet";
            encoding  = address.encoding  || Encoding.Borsh;
        } else {
            url       = toUrl(address);
            networkId = process.env.KARLSEN_NETWORK_ID || "mainnet";
            encoding  = Encoding.Borsh;
        }

        this.url       = url;
        this.networkId = networkId;
        this.address   = address;     // surface this for callers that read it back

        this.rpc = new RpcClient({ url, encoding, networkId });

        // Use the Retry strategy so the underlying client transparently
        // reconnects on transient disconnects — same effective behavior as
        // the long-lived gRPC kaspajs client.
        const connectOpts = ConnectStrategy
            ? { strategy: ConnectStrategy.Retry }
            : undefined;

        this._ready = this.rpc.connect(connectOpts)
            .then(() => {
                if (typeof onConnect === "function") onConnect();
            })
            .catch(err => {
                // Don't throw — the client will keep retrying. Log so the
                // operator sees the failure mode.
                console.error(
                    "karlsenjs: initial connect failed for " + url + ":",
                    (err && err.message) ? err.message : err
                );
            });
    }

    async request(method, params = {}) {

        await this._ready;

        const resolved = resolveMethod(method);
        const fn = this.rpc[resolved];

        if (typeof fn !== "function") {
            throw new Error(
                "karlsenjs: unknown RPC method \"" + method + "\" " +
                "(resolved to \"" + resolved + "\")"
            );
        }

        const raw = await fn.call(this.rpc, params);
        return normalize(raw);
    }

    async disconnect() {
        try { await this.rpc.disconnect(); } catch (_) { /* no-op */ }
    }

    get isConnected() {
        return !!(this.rpc && this.rpc.isConnected);
    }
}

// ---------------------------------------------------------------------------
// walletDaemon — kaspawallet has no Karlsen equivalent. The WASM SDK does
// wallet operations natively (HD derivation, signing, submission via the
// same RpcClient). Export a stub that fails loudly so accidental usage is
// obvious instead of silent.
// ---------------------------------------------------------------------------

class walletDaemon {
    constructor() {
        throw new Error(
            "karlsenjs: walletDaemon is not implemented. " +
            "Use the Karlsen WASM SDK directly for wallet operations " +
            "(Mnemonic / XPrv / PrivateKeyGenerator / createTransactions)."
        );
    }
}

module.exports = {
    Daemon,
    walletDaemon,
    // re-export the WASM bindings for callers that want them
    karlsen,
    // helpers exposed for testing
    _internal: { resolveMethod, normalize, toUrl },
};
