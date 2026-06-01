// ---------------------------------------------------------------------------
// karlsenjs smoke test
//
//   node test.js [ws://host:port]
//
// Defaults to ws://127.0.0.1:43110 (Karlsen mainnet Borsh wRPC).
//
// Exercises the methods the kaspa-clone-api importer relies on, finishing
// with the heavy getVirtualChainFromBlock-from-pruning-point call that the
// importer's chainProcessor hits on first run. If that survives here, the
// importer's reorg-handling path will too. On a fully synced node it can
// return a very large result — that's expected.
//
// Set KARLSEN_TEST_ADDRESS=karlsen:... to also exercise getBalanceByAddress.
// ---------------------------------------------------------------------------

"use strict";

const karlsenjs = require("./index.js");

const URL = process.argv[2] || "ws://127.0.0.1:43110";

let failures = 0;
function check(label, cond, extra) {
    const good = !!cond;
    console.log((good ? "  PASS  " : "  FAIL  ") + label + (extra ? "   " + extra : ""));
    if (!good) failures++;
    return good;
}

(async () => {

    console.log("connecting to " + URL + " ...");
    const daemon = new karlsenjs.Daemon(URL, () => console.log("onConnect fired"));

    // 1. getInfo
    const info = await daemon.request("getInfoRequest");
    check("getInfoRequest", info && typeof info === "object",
        "serverVersion=" + (info && info.serverVersion) +
        " synced=" + (info && info.isSynced));

    // 2. getServerInfo (no Request suffix — passes through verbatim)
    const srv = await daemon.request("getServerInfo");
    check("getServerInfo", srv && srv.networkId != null,
        "networkId=" + (srv && srv.networkId) +
        " synced=" + (srv && srv.isSynced));

    // 3. getBlockDagInfo — also gives us the pruning point for the calls below
    const dag = await daemon.request("getBlockDagInfoRequest");
    const pruning = dag && (dag.pruningPointHash || dag.pruningPoint);
    check("getBlockDagInfoRequest", !!pruning,
        "tips=" + (dag && dag.tipHashes ? dag.tipHashes.length : "?") +
        " daaScore=" + (dag && dag.virtualDaaScore));

    // 4. normalization: 64-bit fields must come back as strings, not BigInt
    check("normalize BigInt->string",
        dag != null && (typeof dag.virtualDaaScore === "string" ||
                        typeof dag.virtualDaaScore === "number"),
        "typeof virtualDaaScore=" + (dag && typeof dag.virtualDaaScore));

    // 5. getBlocks from the pruning point
    const blocks = await daemon.request("getBlocksRequest", {
        lowHash: pruning,
        includeBlocks: true,
        includeTransactions: false,
    });
    const blockList = (blocks && (blocks.blockHashes || blocks.blocks)) || [];
    check("getBlocksRequest", Array.isArray(blockList),
        "count=" + blockList.length);

    // 6. getBalanceByAddress — only if an address is supplied (a bad address
    //    throws), since we have no fixed test vector.
    if (process.env.KARLSEN_TEST_ADDRESS) {
        const bal = await daemon.request("getBalanceByAddressRequest", {
            address: process.env.KARLSEN_TEST_ADDRESS,
        });
        check("getBalanceByAddressRequest", bal && bal.balance != null,
            "balance=" + (bal && bal.balance) +
            " (typeof " + (bal && typeof bal.balance) + ")");
    } else {
        console.log("  SKIP  getBalanceByAddressRequest (set KARLSEN_TEST_ADDRESS to run)");
    }

    // 7. The heavy one: virtual chain from the pruning point. Same shape
    //    chainProcessor hits on first run. Can be large/slow on a synced
    //    node; if it times out or OOMs, the importer needs the same chunking
    //    it already applies elsewhere.
    console.log("  ....  getVirtualChainFromBlock from pruning point (may be large) ...");
    const t0 = Date.now();
    const vspc = await daemon.request("getVirtualSelectedParentChainFromBlockRequest", {
        startHash: pruning,
        includeAcceptedTransactionIds: true,
    });
    const added = (vspc && vspc.addedChainBlockHashes) || [];
    const accepted = (vspc && vspc.acceptedTransactionIds) || [];
    check("getVirtualSelectedParentChainFromBlockRequest", Array.isArray(added),
        "added=" + added.length +
        " acceptedBlocks=" + accepted.length +
        " in " + (Date.now() - t0) + "ms");

    await daemon.disconnect();

    console.log("\n" + (failures === 0 ? "ALL PASS" : (failures + " CHECK(S) FAILED")));
    process.exit(failures ? 1 : 0);

})().catch(e => {
    console.error("\nfatal:", e);
    process.exit(1);
});
