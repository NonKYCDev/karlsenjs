# karlsenjs

A drop-in shim that exposes the Karlsen (rusty-karlsen) WASM `RpcClient`
through the same `Daemon` / `.request("getXRequest", params)` surface as
`kaspajs` / `keryxjs` / `htnjs`.

It lets a `kaspa-clone-api`-style indexer/API add a Karlsen-backed chain over
**wRPC** by adding one entry to `config.daemons` — no code changes in the
consuming app. This is the sibling of `keryxjs`; same internals, adapted for
the `karlsen-wasm` bundle and Karlsen's ports.

> **gRPC vs wRPC:** if you currently run a *gRPC*-based `karlsenjs` (the
> classic `kaspajs`-style connector), this package **replaces** it for the
> `karlsen` daemon entry. Point the config address at Karlsen's **wRPC**
> port, not the gRPC port (see Ports below). Pick one connector per daemon
> key — the importer resolves `require("karlsenjs")`, so both can't coexist
> under the same name.

## Install

The `karlsen-wasm` Node bundle is **vendored in this repo** at
`nodejs/karlsen/`, so a clone is self-contained — no separate download step.
Just place the package at `node_modules/karlsenjs/` (or add it to
`package.json` and `npm install`) and the shim's default
`require("./nodejs/karlsen")` resolves to the committed bundle.

To use a bundle from elsewhere instead (e.g. one shared with `walletEngine`),
override the lookup with an env var — it takes precedence over the vendored
copy:

    export KARLSEN_WASM_PATH=/absolute/path/to/wasm/nodejs/karlsen

PM2 users can put this in `ecosystem.config.js` under `env`.

The `websocket` dependency exists because the Karlsen WASM Node client uses
the global `WebSocket`, which Node only provides natively from v21+. On Node
16 (NonKYC's stack) the shim installs `websocket`'s `w3cwebsocket` as the
global automatically; on newer Node it's a no-op.

Similarly, the WASM client needs a global Web `crypto` (`getRandomValues`,
used by `ahash`/`getrandom`) at `RpcClient` construction. Node only exposes a
global `crypto` from ~v19+, so on Node 16/18 the shim polyfills it from
`node:crypto`'s `webcrypto` (no extra dependency). Without this, constructing a
client on older Node aborts with a bare `RuntimeError: unreachable`
("getrandom::fill() failed").

## Usage

```js
const karlsen = require("karlsenjs");

const daemon = new karlsen.Daemon("127.0.0.1:43110", () => {
    console.log("connected");
});

const info = await daemon.request("getInfoRequest");
// { isSynced: true, serverVersion: "...", ... }
```

In the `kaspa-clone-api` codebase, add an entry to `config.json`:

```json
{ "daemon": "karlsen", "address": "ws://127.0.0.1:43110" }
```

The importer's `require(thisDaemon.daemon + "js")` picks up `karlsenjs` and
calls `new Daemon(address, onConnect)` exactly as it does for the other
forks. No changes to `importer.js` or `index.js`.

## Ports

Karlsen's default listen ports (from rusty-karlsen `consensus/core/src/network.rs`
and `karlsend/src/args.rs`):

| Interface          | Mainnet | Testnet |
|--------------------|---------|---------|
| gRPC               | 42110   | 42210   |
| P2P                | 42111   | 42211   |
| **wRPC (Borsh)**   | **43110** | 43210 |
| wRPC (JSON)        | 44110   | 44210   |

This shim defaults to **Borsh** encoding, so point it at the Borsh wRPC port
(43110 mainnet). Make sure `karlsend` is started with that listener enabled,
e.g. `--rpclisten-borsh=0.0.0.0:43110` (or `default` / `127.0.0.1:43110`).
`ws://` is auto-prepended if you omit the scheme.

To use JSON encoding instead, construct with the options form:

```js
new karlsen.Daemon({ url: "ws://127.0.0.1:44110", encoding: karlsen.karlsen.Encoding.SerdeJson });
```

## Method name mapping

| Legacy gRPC name                                  | Karlsen WASM method          |
|---------------------------------------------------|------------------------------|
| `getInfoRequest`                                  | `getInfo`                    |
| `getBlockDagInfoRequest`                          | `getBlockDagInfo`            |
| `getBlocksRequest`                                | `getBlocks`                  |
| `getBlockRequest`                                 | `getBlock`                   |
| `getBalanceByAddressRequest`                      | `getBalanceByAddress`        |
| `getUtxosByAddressesRequest`                      | `getUtxosByAddresses`        |
| `getVirtualSelectedParentChainFromBlockRequest`   | `getVirtualChainFromBlock`   |

The trailing `Request` is stripped automatically; only the VSPC rename needs
an explicit alias (in `METHOD_ALIASES` in `index.js`). Any other method
exposed on the WASM `RpcClient` is reachable via the same `request()` call —
e.g. `daemon.request("getServerInfo")` works with no further configuration.

## Response normalization

Every response is passed through a JSON round-trip that:

- Converts `BigInt` values to **strings** (matches the gRPC wire shape so
  existing `parseInt(...)` / `+x` consumers don't throw on 64-bit fields).
- Converts `Uint8Array` values to **hex strings** (matches how the gRPC
  daemons return `signatureScript` and similar byte fields).

If you need raw BigInts/byte arrays, call the underlying client directly via
`daemon.rpc` or the re-exported `require("karlsenjs").karlsen` bindings.

## Wallet operations

`walletDaemon` is intentionally a throwing stub — there is no `kaspawallet`
equivalent. Use the Karlsen WASM SDK directly (`Mnemonic` / `XPrv` /
`PrivateKeyGenerator` / `createTransactions`) for HD derivation, signing, and
submission, all over the same `RpcClient`.

## Building / refreshing the WASM bundle

The bundle under `nodejs/karlsen/` is the `wasm32-sdk`, `--target nodejs`
output of rusty-karlsen's `wasm` crate. Build it from the **same checkout as
the node you connect to** (e.g. your `v3.1.1` tree, with the `=0.2.106`
wasm-bindgen pin applied) so the client SDK and the daemon stay protocol-aligned:

```bash
# one-time toolchain prereqs
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

cd /path/to/rusty-karlsen/wasm
./build-node          # wasm-pack build --target nodejs --out-name karlsen \
                      #   --out-dir nodejs/karlsen --features wasm32-sdk
```

Then vendor it into this repo:

```bash
cd /path/to/karlsenjs
rm -rf nodejs/karlsen
cp -r /path/to/rusty-karlsen/wasm/nodejs/karlsen nodejs/karlsen

# wasm-pack drops a .gitignore containing "*" in its out-dir, which would
# silently exclude the whole bundle from git. Remove it before adding:
rm -f nodejs/karlsen/.gitignore

git add nodejs/karlsen      # or: git add -f nodejs/karlsen
git commit -m "Vendor karlsen-wasm nodejs bundle"
```

> The `rm -f nodejs/karlsen/.gitignore` step is the easy one to forget — if a
> fresh clone has an empty `nodejs/karlsen/`, that wasm-pack `.gitignore` is
> why.

## Smoke test

```
node node_modules/karlsenjs/test.js ws://127.0.0.1:43110
```

Exercises the methods the importer relies on and finishes with the heavy
`getVirtualChainFromBlock`-from-pruning-point call — the same shape
`chainProcessor` hits on first run. If that survives here, the importer's
reorg path will too. Set `KARLSEN_TEST_ADDRESS` to also exercise
`getBalanceByAddress`.
