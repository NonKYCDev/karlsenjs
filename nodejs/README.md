# nodejs/

The Karlsen WASM Node bundle is vendored here, at `nodejs/karlsen/`.

It is the `wasm-pack --target nodejs --out-name karlsen --features wasm32-sdk`
output of rusty-karlsen's `wasm` crate (`wasm/build-node`), and contains:

    karlsen.js        karlsen_bg.wasm        karlsen.d.ts        package.json

The shim's default loader does `require("./nodejs/karlsen")`, which resolves
to this directory's `package.json` -> `karlsen.js`.

To (re)build and vendor it, see "Building / refreshing the WASM bundle" in the
top-level README. Remember to delete the wasm-pack-generated
`nodejs/karlsen/.gitignore` (it contains `*`) before `git add`, or the bundle
won't be tracked.
