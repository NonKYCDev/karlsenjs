# repatch-wasm.sh — fix the wasm-bindgen 0.2.106 (--weak-refs, --target nodejs)
# codegen bug where the closure adapter for the WebSocket `onmessage`
# (MessageEvent) handler is merged with a `[U32]` closure and passes its
# argument to wasm RAW instead of via addHeapObject(). Result: every inbound
# wRPC message throws `TypeError: Cannot read properties of undefined
# (reading 'data')` in __wbg_data.
#
# This rewrites that one adapter to dispatch on type: numbers (the U32 closure)
# pass through raw, objects (the MessageEvent) are heap-wrapped. Idempotent.
#
# Run from the package root after (re)building/vendoring the bundle:
#   ./tools/repatch-wasm.sh            # patches nodejs/karlsen/karlsen.js
#   ./tools/repatch-wasm.sh path/to/karlsen.js
set -e

JS="${1:-nodejs/karlsen/karlsen.js}"
[ -f "$JS" ] || { echo "not found: $JS"; exit 1; }

# The adapter used by the MessageEvent closure: it's the second func_elem
# reference on the line right after the MessageEvent cast comment.
FE=$(grep -A1 'NamedExternref("MessageEvent")' "$JS" \
     | grep -o '__wasm_bindgen_func_elem_[0-9]*' | tail -1)

if [ -z "$FE" ]; then
  echo "Could not locate the MessageEvent closure adapter."
  echo "Either the bundle is already patched, or its layout changed — inspect manually."
  exit 1
fi

if grep -q "function ${FE}(arg0, arg1, arg2) {" "$JS" \
   && grep -A2 "^function ${FE}(arg0, arg1, arg2) {" "$JS" | grep -q "addHeapObject"; then
  echo "Already patched ($FE)."
  exit 0
fi

echo "Patching adapter: $FE"
perl -0777 -i -pe "s/function ${FE}\\(arg0, arg1, arg2\\) \\{\\n    wasm\\.${FE}\\(arg0, arg1, arg2\\);\\n\\}/function ${FE}(arg0, arg1, arg2) {\\n    wasm.${FE}(arg0, arg1, typeof arg2 === \"number\" ? arg2 : addHeapObject(arg2));\\n}/" "$JS"

echo "Result:"
grep -A2 "^function ${FE}(arg0, arg1, arg2) {" "$JS"
