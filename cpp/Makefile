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
  -msimd128 \
  -msse2 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="ChromashiftEngine" \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_computeAverageLuminance","_computeAverageLuminanceStrided","_classifyPixel","_classifyPixelsBulk","_computeClassificationMask","_computeLuminanceHistogram","_computeColorBandCounts","_durationToDecay","_advanceLayerAngles","_simulateTracerDecay"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAP32","HEAPF32"]' \
  -s INITIAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1 \
  --bind

# ─── Host-side unit tests (plain g++, no Emscripten) ─────────────────────────
CXX      := g++
TEST_BIN := tests/test_engine
TEST_SRC := tests/test_engine.cpp

# ─── Targets ─────────────────────────────────────────────────────────────────
.PHONY: all clean check test verify-exports

all: $(OUT_JS)

$(OUT_JS): $(SRC) $(HEADER)
	$(EMCC) $(SRC) $(EMFLAGS) -o $(OUT_JS)
	@echo "✅  WASM build complete:"
	@echo "     $(OUT_JS)"
	@echo "     $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM) $(TEST_BIN)

# Verify Emscripten is on PATH before attempting a build.
check:
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	@echo "✅  emcc found: $$($(EMCC) --version | head -1)"

$(TEST_BIN): $(SRC) $(TEST_SRC) $(HEADER)
	$(CXX) -std=c++17 -Wall -Wextra -I. $(SRC) $(TEST_SRC) -o $(TEST_BIN) -lm

test: $(TEST_BIN)
	./$(TEST_BIN)

# Ensure EXPORTED_FUNCTIONS matches every EMSCRIPTEN_KEEPALIVE symbol in the header.
verify-exports:
	@missing=$$(grep -oE '^[a-zA-Z_][a-zA-Z0-9_]*' $(HEADER) \
	  | grep -vE '^(extern|ifdef|endif|include|pragma|float|int|void|uint|const|static|double|auto|return|else|for|if|using|namespace|function|optional_override|reinterpret_cast|EMSCRIPTEN_BINDINGS|chromashift_engine)$$' \
	  | while read -r fn; do \
	      echo '$(EMFLAGS)' | grep -q "_$$fn" || echo "$$fn"; \
	    done); \
	if [ -n "$$missing" ]; then \
	  echo "❌  EXPORTED_FUNCTIONS missing:"; echo "$$missing"; exit 1; \
	fi
	@echo "✅  EXPORTED_FUNCTIONS matches $(HEADER)"
