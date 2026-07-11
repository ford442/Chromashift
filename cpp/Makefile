# Chromashift — C++ → WebAssembly Build
#
# Prerequisites:
#   Emscripten SDK  https://emscripten.org/docs/getting_started/downloads.html
#
# Quick start:
#   source /path/to/emsdk/emsdk_env.sh   # activate Emscripten in your shell
#   npm run codegen:band                # shared/band.json → cpp/band_table.h
#   cd cpp && make release              # optimised build (default)
#   cd cpp && make debug                # assertions + symbols
#   npm run dev                         # Vite serves the .wasm from /public/

EMCC     := emcc
SRC      := chromashift_engine.cpp
HEADER   := chromashift_engine.h
BAND_HDR := band_table.h

# Outputs land in /public/ so Vite's dev server and production build both serve them.
OUT_JS   := ../public/chromashift_engine.js
OUT_WASM := ../public/chromashift_engine.wasm

# Every EMSCRIPTEN_KEEPALIVE symbol — keep in sync with chromashift_engine.h
EXPORTED_FUNCS := \
  _malloc,_free,_computeAverageLuminance,_computeAverageLuminanceStrided,\
  _classifyPixel,_buildBandLut,_classifyPixelLut,\
  _classifyPixelsBulk,_classifyPixelsBulkLut,\
  _computeClassificationMask,_computeClassificationMaskLut,\
  _computeLuminanceHistogram,_computeColorBandCounts,\
  _buildRotationMat3,_durationToDecay,_advanceLayerAngles,_simulateTracerDecay

# Shared Emscripten link flags (debug vs release differ only in -O / ASSERTIONS)
EMFLAGS_COMMON := \
  -msimd128 \
  -msse2 \
  -fno-exceptions \
  -fno-rtti \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="ChromashiftEngine" \
  -s EXPORTED_FUNCTIONS='[$(EXPORTED_FUNCS)]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAP32","HEAPF32"]' \
  -s INITIAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1 \
  --bind

EMFLAGS_RELEASE := -O3 $(EMFLAGS_COMMON)
EMFLAGS_DEBUG   := -O0 -g -s ASSERTIONS=1 $(EMFLAGS_COMMON)

# ─── Host-side unit tests (plain g++, no Emscripten) ─────────────────────────
CXX      := g++
TEST_BIN := tests/test_engine
TEST_SRC := tests/test_engine.cpp

# ─── Targets ─────────────────────────────────────────────────────────────────
.PHONY: all release debug clean check test verify-exports codegen

all: release

release: EMFLAGS := $(EMFLAGS_RELEASE)
release: $(OUT_JS)

debug: EMFLAGS := $(EMFLAGS_DEBUG)
debug: $(OUT_JS)

codegen:
	node ../scripts/codegen-band.mjs

$(OUT_JS): $(SRC) $(HEADER) $(BAND_HDR)
	$(EMCC) $(SRC) $(EMFLAGS) -o $(OUT_JS)
	@echo "✅  WASM build complete ($(if $(findstring ASSERTIONS=1,$(EMFLAGS)),debug,release)):"
	@echo "     $(OUT_JS)"
	@echo "     $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM) $(TEST_BIN)

check:
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	@echo "✅  emcc found: $$($(EMCC) --version | head -1)"

$(TEST_BIN): $(SRC) $(TEST_SRC) $(HEADER) $(BAND_HDR)
	$(CXX) -std=c++17 -Wall -Wextra -I. $(SRC) $(TEST_SRC) -o $(TEST_BIN) -lm

test: $(TEST_BIN)
	./$(TEST_BIN)

# Ensure EXPORTED_FUNCTIONS matches every EMSCRIPTEN_KEEPALIVE symbol in the header.
verify-exports:
	@missing=$$(grep -E '^[a-zA-Z_][a-zA-Z0-9_]*\(' $(HEADER) \
	  | sed 's/(.*//' \
	  | grep -vE '^(extern|ifdef|endif)$$' \
	  | while read -r fn; do \
	      echo "$(EXPORTED_FUNCS)" | grep -q "_$$fn" || echo "$$fn"; \
	    done); \
	if [ -n "$$missing" ]; then \
	  echo "❌  EXPORTED_FUNCTIONS missing:"; echo "$$missing"; exit 1; \
	fi
	@echo "✅  EXPORTED_FUNCTIONS matches $(HEADER)"
