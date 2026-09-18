# Chromashift — C++ → WebAssembly Build
#
# Prerequisites:
#   Emscripten SDK  https://emscripten.org/docs/getting_started/downloads.html
#
# Quick start:
#   source /path/to/emsdk/emsdk_env.sh   # activate Emscripten in your shell
#   npm run codegen                     # shared/*.json → cpp/*_table.h
#   cd cpp && make release              # optimised build (default)
#   cd cpp && make debug                # assertions + symbols
#   cd cpp && make rebuild              # force clean rebuild (fixes stale artifacts)
#   npm run dev                         # Vite serves the .wasm from /public/

EMCC     := emcc
# Resolve node via the shell (skips directories). Raw PATH lookup after
# `source emsdk_env.sh` can hit the `/…/emsdk/node` *directory* and fail with
# EACCES when make execs it directly — common under emmake/Colab.
NODE     := $(shell command -v node 2>/dev/null)
SRC      := chromashift_engine.cpp
HEADER   := chromashift_engine.h
BAND_HDR := band_table.h
BAND_JSON := ../shared/band.json
BAND_CODEGEN := ../scripts/codegen-band.mjs
DECAY_HDR := decay_table.h
DECAY_JSON := ../shared/decay.json
DECAY_CODEGEN := ../scripts/codegen-decay.mjs
GEN_HDRS := $(BAND_HDR) $(DECAY_HDR)

# Outputs land in /public/ so Vite's dev server and production build both serve them.
OUT_JS   := ../public/chromashift_engine.js
OUT_WASM := ../public/chromashift_engine.wasm

# Stamp files (gitignored) — track build mode + link flags so flag-only edits
# and release↔debug switches invalidate committed/prebuilt artifacts.
MODE_STAMP  := .wasm_mode
FLAGS_STAMP := .wasm_flags

# Every EMSCRIPTEN_KEEPALIVE symbol — keep in sync with chromashift_engine.h
EXPORTED_FUNCS := \
  _malloc,_free,_computeAverageLuminance,_computeAverageLuminanceStrided,\
  _classifyPixel,_buildBandLut,_classifyPixelLut,\
  _classifyPixelsBulk,_classifyPixelsBulkLut,\
  _computeClassificationMask,_computeClassificationMaskLut,\
  _computeLuminanceHistogram,_computeColorBandCounts,\
  _buildRotationMat3,_durationToDecay,_advanceLayerAngles,_advanceLayerAngles3,\
  _simulateTracerDecay

# Shared Emscripten link flags (debug vs release differ only in -O / ASSERTIONS / -flto)
#
# The module exports one ABI: the flat C symbols in EXPORTED_FUNCS, called from
# TypeScript as mod._name(ptr, ...).  There is deliberately no embind layer —
# every binding it used to carry was a reinterpret_cast passthrough over the same
# C ABI, and dropping it also drops the -fno-rtti / UNBOUND_TYPE_NAMES workarounds
# it needed.  `make verify-exports` is the single source of truth for the list.
#
# -msimd128 enables the hand-written wasm_simd128.h kernels in the engine
# (guarded by __wasm_simd128__).  No -msse2: nothing includes the x86 headers.
# ENVIRONMENT=web,worker + FILESYSTEM=0 drop the Node/shell and filesystem glue —
# the engine only ever runs in a browser window or a Web Worker.
#
# Release-only: -flto and --closure 1 (the glue is a thin C-ABI shim, so Closure
# has nothing to break and halves it).  Both are off in debug builds so stack
# traces and ASSERTIONS output stay readable.  Output is reproducible for a
# pinned emsdk version, which the wasm-freshness workflow relies on.
EMFLAGS_COMMON := \
  -msimd128 \
  -fno-exceptions \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="ChromashiftEngine" \
  -s EXPORTED_FUNCTIONS='[$(EXPORTED_FUNCS)]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAP32","HEAPF32"]' \
  -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 \
  -s INITIAL_MEMORY=67108864 \
  -s ALLOW_MEMORY_GROWTH=1

EMFLAGS_RELEASE := -O3 -flto --closure 1 $(EMFLAGS_COMMON)
EMFLAGS_DEBUG   := -O0 -g -s ASSERTIONS=1 $(EMFLAGS_COMMON)

# ─── Host-side unit tests (plain g++, no Emscripten) ─────────────────────────
CXX      := g++
TEST_BIN := tests/test_engine
TEST_SRC := tests/test_engine.cpp

# ─── Targets ─────────────────────────────────────────────────────────────────
.PHONY: all release debug clean check test verify-exports codegen rebuild \
        ensure-mode ensure-flags _build

all: release

# Force a clean rebuild. Use this when make reports "Nothing to be done" but
# public/chromashift_engine.{js,wasm} are still stale (committed artifacts newer
# than sources, equal checkout mtimes, or a previous emcc version).
rebuild: clean release

# Two-phase build so `make -j` cannot race: ensure-* may delete OUT_JS/OUT_WASM,
# then a nested make re-evaluates whether the outputs need compiling.
# Only pass CS_BUILD_MODE (a single word) across the recursive boundary —
# carrying EMFLAGS on the make command line strips the embedded quotes.
release:
	@$(MAKE) --no-print-directory _build CS_BUILD_MODE=release

debug:
	@$(MAKE) --no-print-directory _build CS_BUILD_MODE=debug

_build: ensure-mode ensure-flags
	@$(MAKE) --no-print-directory $(OUT_JS) CS_BUILD_MODE=$(CS_BUILD_MODE)

codegen: $(GEN_HDRS)

# Invalidate artifacts when switching release ↔ debug.
ensure-mode:
	@mode="$(CS_BUILD_MODE)"; \
	if [ -z "$$mode" ]; then mode=release; fi; \
	if [ ! -f $(MODE_STAMP) ] || [ "$$(cat $(MODE_STAMP))" != "$$mode" ]; then \
	  echo "→ build mode: $$mode (invalidating previous WASM artifacts)"; \
	  rm -f $(OUT_JS) $(OUT_WASM); \
	  echo "$$mode" > $(MODE_STAMP); \
	fi

# Invalidate artifacts when EXPORTED_FUNCS / EMFLAGS change in this Makefile.
ensure-flags:
	@printf '%s\n' \
	  "EXPORTED_FUNCS=$(EXPORTED_FUNCS)" \
	  "EMFLAGS_RELEASE=$(EMFLAGS_RELEASE)" \
	  "EMFLAGS_DEBUG=$(EMFLAGS_DEBUG)" \
	  > $(FLAGS_STAMP).new
	@if [ ! -f $(FLAGS_STAMP) ] || ! cmp -s $(FLAGS_STAMP) $(FLAGS_STAMP).new; then \
	  echo "→ emcc flags changed (invalidating previous WASM artifacts)"; \
	  rm -f $(OUT_JS) $(OUT_WASM); \
	  mv $(FLAGS_STAMP).new $(FLAGS_STAMP); \
	else \
	  rm -f $(FLAGS_STAMP).new; \
	fi

# shared/*.json → *_table.h (codegen only rewrites when content changes).
# Depend on the JSON only — not the codegen script — so editing the script
# does not force an every-build no-op regenerate.
$(BAND_HDR): $(BAND_JSON)
	@if [ -z "$(NODE)" ]; then \
	  echo "❌  node not found on PATH — cannot regenerate $(BAND_HDR)"; \
	  echo "    Run: npm run codegen:band"; \
	  exit 1; \
	fi
	$(NODE) $(BAND_CODEGEN)

$(DECAY_HDR): $(DECAY_JSON)
	@if [ -z "$(NODE)" ]; then \
	  echo "❌  node not found on PATH — cannot regenerate $(DECAY_HDR)"; \
	  echo "    Run: npm run codegen:decay"; \
	  exit 1; \
	fi
	$(NODE) $(DECAY_CODEGEN)

# Select flags from CS_BUILD_MODE (set by release/debug → _build).
# Expanded in the recipe so nested make does not mangle quoted -s args.
CS_EMFLAGS = $(if $(filter debug,$(CS_BUILD_MODE)),$(EMFLAGS_DEBUG),$(EMFLAGS_RELEASE))

# Grouped target (&:) so -j does not run emcc twice for the dual outputs.
# Also depends on Makefile so editing this file forces a rebuild.
$(OUT_JS) $(OUT_WASM) &: $(SRC) $(HEADER) $(GEN_HDRS) Makefile
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	$(EMCC) $(SRC) $(CS_EMFLAGS) -o $(OUT_JS)
	@echo "✅  WASM build complete ($(if $(filter debug,$(CS_BUILD_MODE)),debug,release)):"
	@echo "     $(OUT_JS)"
	@echo "     $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM) $(TEST_BIN) $(MODE_STAMP) $(FLAGS_STAMP) $(FLAGS_STAMP).new

check:
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	@echo "✅  emcc found: $$($(EMCC) --version | head -1)"

$(TEST_BIN): $(SRC) $(TEST_SRC) $(HEADER) $(GEN_HDRS)
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
