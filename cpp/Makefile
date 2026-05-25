# Chromashift — C++ → WebAssembly Build
#
# Prerequisites:
#   Emscripten SDK  https://emscripten.org/docs/getting_started/downloads.html
#
# Quick start:
#   source /path/to/emsdk/emsdk_env.sh   # activate Emscripten in your shell
#   cd cpp && make                        # produces public/chromashift_engine.{js,wasm}
#   npm run dev                           # Vite serves the .wasm from /public/

EMCC     := emcc
SRC      := chromashift_engine.cpp
HEADER   := chromashift_engine.h

# Outputs land in /public/ so Vite's dev server and production build both serve them.
OUT_JS   := ../public/chromashift_engine.js
OUT_WASM := ../public/chromashift_engine.wasm

# ─── Emscripten flags ────────────────────────────────────────────────────────
EMFLAGS := \
  -O3 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="ChromashiftEngine" \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_computeAverageLuminance","_classifyPixel","_classifyPixelsBulk","_computeLuminanceHistogram","_computeColorBandCounts","_durationToDecay","_advanceLayerAngles","_simulateTracerDecay"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAP32","HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  --bind

# ─── Targets ─────────────────────────────────────────────────────────────────
.PHONY: all clean check

all: $(OUT_JS)

$(OUT_JS): $(SRC) $(HEADER)
	$(EMCC) $(SRC) $(EMFLAGS) -o $(OUT_JS)
	@echo "✅  WASM build complete:"
	@echo "     $(OUT_JS)"
	@echo "     $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM)

# Verify Emscripten is on PATH before attempting a build.
check:
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	@echo "✅  emcc found: $$($(EMCC) --version | head -1)"
