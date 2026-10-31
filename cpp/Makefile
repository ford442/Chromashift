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
# Pinned Emscripten version. `.github/workflows/wasm.yml` reads this file and
# installs exactly this emsdk, which is what makes "committed artifacts match a
# clean rebuild" a meaningful check — closure output is only reproducible for a
# pinned toolchain. `make check` warns when the active emcc disagrees.
EMSDK_VERSION_FILE := emsdk.version
EMSDK_VERSION := $(strip $(shell cat $(EMSDK_VERSION_FILE) 2>/dev/null))
# Resolve node via the shell (skips directories). Raw PATH lookup after
# `source emsdk_env.sh` can hit the `/…/emsdk/node` *directory* and fail with
# EACCES when make execs it directly — common under emmake/Colab.
NODE     := $(shell command -v node 2>/dev/null)
SRCS     := chromashift_engine.cpp motion_flow.cpp
HEADER   := chromashift_engine.h
# Internal headers every engine TU includes (not part of the exported interface).
INTERNAL_HDRS := simd_util.h
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
  _buildRotationMat3,_durationToDecay,\
  _computeMotionFlow

# ─── Compile flags: the one source ───────────────────────────────────────────
#
# Every compile of the engine — host g++ tests, the em++ SIMD tests, the shipped
# emcc build and the clangd database (`make compile-commands` passes these to
# scripts/gen-compile-commands.mjs) — starts from CXXFLAGS_COMMON, so a warning
# that fails `make test-werror` in CI cannot be silently absent from the shipped
# build, and the editor sees exactly what the compiler sees.
#
# -ffp-contract=off: never fuse a*b+c into an FMA. The kernels are written so
# the scalar, SIMD128, TypeScript and WGSL lanes round identically, and an
# aarch64 host (where clang contracts by default) would otherwise fuse the
# lkSolve arithmetic and make the host tests platform-dependent. wasm32 has no
# scalar FMA, so the shipped build is unaffected; it is pinned there anyway so
# the guarantee does not rest on that.
CXXFLAGS_COMMON := -std=c++17 -Wall -Wextra -ffp-contract=off -I.

# Code-generation flags for the wasm32 target (compile side only; the -s link
# settings follow). -msimd128 enables the hand-written wasm_simd128.h kernels.
# Never add -mrelaxed-simd: relaxed ops (FMA, swizzle, min/max) have
# implementation-defined results, which would break bit-exact SIMD-vs-scalar
# parity (tests/simd_parity.cpp) and make output differ between browsers.
WASM_CXXFLAGS := $(CXXFLAGS_COMMON) -msimd128 -fno-exceptions -fno-rtti

# Shared Emscripten link flags (debug vs release differ only in -O / ASSERTIONS / -flto)
#
# The module exports one ABI: the flat C symbols in EXPORTED_FUNCS, called from
# TypeScript as mod._name(ptr, ...).  There is deliberately no embind layer —
# every binding it used to carry was a reinterpret_cast passthrough over the same
# C ABI, and dropping it also drops the -fno-rtti / UNBOUND_TYPE_NAMES workarounds
# it needed.  `make verify-exports` is the single source of truth for the list.
#
# No -msse2: nothing includes the x86 headers. -fno-rtti: nothing uses
# typeid/dynamic_cast (there is no embind). ENVIRONMENT=web,worker + FILESYSTEM=0
# drop the Node/shell and filesystem glue — the engine only ever runs in a
# browser window or a Web Worker. DYNAMIC_EXECUTION=0 keeps eval/new Function out
# of the glue, so the app works under a strict CSP.
#
# MALLOC=emmalloc: the engine allocates a handful of long-lived buffers (the
# TypeScript side pools its inputs, motion_flow.cpp keeps a grow-only arena), so
# dlmalloc's small-object bins buy nothing; emmalloc is ~13% smaller.
#
# INITIAL_MEMORY is 16 MiB plus growth. Up to three instances exist at once (main
# thread, analysis worker, motion worker) and each reserves this up front; the
# large buffers — a 4K–8K RGBA image and its mask — grow the heap on first use
# and the TypeScript pool keeps it from churning after that.
#
# Release-only: -flto and --closure 1 (the glue is a thin C-ABI shim, so Closure
# has nothing to break and halves it).  Both are off in debug builds so stack
# traces and ASSERTIONS output stay readable.  Output is reproducible for a
# pinned emsdk version, which the wasm-freshness workflow relies on.
EMFLAGS_COMMON := \
  $(WASM_CXXFLAGS) \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="ChromashiftEngine" \
  -s EXPORTED_FUNCTIONS='[$(EXPORTED_FUNCS)]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAP32","HEAPF32"]' \
  -s ENVIRONMENT=web,worker \
  -s FILESYSTEM=0 \
  -s DYNAMIC_EXECUTION=0 \
  -s MALLOC=emmalloc \
  -s INITIAL_MEMORY=16777216 \
  -s ALLOW_MEMORY_GROWTH=1

EMFLAGS_RELEASE := -O3 -flto --closure 1 $(EMFLAGS_COMMON)
EMFLAGS_DEBUG   := -O0 -g -s ASSERTIONS=1 $(EMFLAGS_COMMON)

# ─── Host-side unit tests (plain g++, no Emscripten) ─────────────────────────
CXX      := g++
TEST_BIN := tests/test_engine
TEST_SRC := tests/test_engine.cpp
TEST_ASAN_BIN := tests/test_engine_asan
TEST_CXXFLAGS := $(CXXFLAGS_COMMON)

# ─── SIMD128 tests (em++ -msimd128, run under Node) ─────────────────────────
# The host build above never compiles a CS_HAS_SIMD block, so these are the
# tests of the code the browser actually runs:
#   test-simd    the whole tests/test_engine.cpp suite against the SIMD build
#   test-parity  tests/simd_parity.cpp — the SIMD and the scalar engine linked
#                into one module (tests/scalar_*.cpp recompile every engine TU
#                with CS_FORCE_SCALAR and renamed exports) and compared bit for
#                bit on odd sizes and NaN / denormal / extreme inputs
# -O3 like the release build, so the optimiser sees what it sees in production.
# `.cjs` because the repo's package.json is "type": "module" and the Node glue
# is CommonJS.
EMXX          := em++
EMTEST_FLAGS  := $(WASM_CXXFLAGS) -O3 -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1
SIMD_TEST_JS  := tests/test_engine_simd.cjs
PARITY_JS     := tests/simd_parity.cjs
PARITY_SRCS   := tests/simd_parity.cpp tests/scalar_engine.cpp tests/scalar_motion_flow.cpp
PARITY_HDRS   := tests/scalar_names.h

# ─── Targets ─────────────────────────────────────────────────────────────────
.PHONY: all release debug clean check check-emsdk-version test test-werror test-asan \
        test-simd test-parity verify-exports codegen rebuild compile-commands \
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
# does not force an every-build no-op regenerate. The trailing `touch` matters
# for the same reason: when the JSON is newer but the generated text is
# unchanged, codegen leaves the header's mtime alone, so without it the header
# would stay older than the JSON and be "rebuilt" on every make.
$(BAND_HDR): $(BAND_JSON)
	@if [ -z "$(NODE)" ]; then \
	  echo "❌  node not found on PATH — cannot regenerate $(BAND_HDR)"; \
	  echo "    Run: npm run codegen:band"; \
	  exit 1; \
	fi
	$(NODE) $(BAND_CODEGEN)
	@touch $@

$(DECAY_HDR): $(DECAY_JSON)
	@if [ -z "$(NODE)" ]; then \
	  echo "❌  node not found on PATH — cannot regenerate $(DECAY_HDR)"; \
	  echo "    Run: npm run codegen:decay"; \
	  exit 1; \
	fi
	$(NODE) $(DECAY_CODEGEN)
	@touch $@

# Select flags from CS_BUILD_MODE (set by release/debug → _build).
# Expanded in the recipe so nested make does not mangle quoted -s args.
CS_EMFLAGS = $(if $(filter debug,$(CS_BUILD_MODE)),$(EMFLAGS_DEBUG),$(EMFLAGS_RELEASE))

# Grouped target (&:) so -j does not run emcc twice for the dual outputs.
# Also depends on Makefile so editing this file forces a rebuild.
$(OUT_JS) $(OUT_WASM) &: $(SRCS) $(HEADER) $(INTERNAL_HDRS) $(GEN_HDRS) Makefile
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	$(EMCC) $(SRCS) $(CS_EMFLAGS) -o $(OUT_JS)
	@echo "✅  WASM build complete ($(if $(filter debug,$(CS_BUILD_MODE)),debug,release)):"
	@echo "     $(OUT_JS)"
	@echo "     $(OUT_WASM)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM) $(TEST_BIN) $(TEST_ASAN_BIN) compile_commands.json \
	  $(SIMD_TEST_JS) $(SIMD_TEST_JS:.cjs=.wasm) $(PARITY_JS) $(PARITY_JS:.cjs=.wasm) \
	  $(MODE_STAMP) $(FLAGS_STAMP) $(FLAGS_STAMP).new

check:
	@command -v $(EMCC) >/dev/null 2>&1 || \
	  (echo "❌  emcc not found — run: source /path/to/emsdk/emsdk_env.sh" && exit 1)
	@echo "✅  emcc found: $$($(EMCC) --version | head -1)"
	@$(MAKE) --no-print-directory check-emsdk-version

# Compare the active emcc against cpp/emsdk.version. A warning, not an error:
# a local mismatch is usually fine, but it explains a surprising artifact diff.
check-emsdk-version:
	@if [ -z "$(EMSDK_VERSION)" ]; then \
	  echo "⚠️   $(EMSDK_VERSION_FILE) missing — cannot verify the emsdk pin"; \
	  exit 0; \
	fi; \
	active=$$($(EMCC) -dumpversion 2>/dev/null); \
	if [ "$$active" = "$(EMSDK_VERSION)" ]; then \
	  echo "✅  emsdk matches the pin in $(EMSDK_VERSION_FILE): $(EMSDK_VERSION)"; \
	else \
	  echo "⚠️   emsdk $$active does not match the pin in $(EMSDK_VERSION_FILE) ($(EMSDK_VERSION))."; \
	  echo "    Committed public/chromashift_engine.* are reproducible only for the pinned version."; \
	fi

$(TEST_BIN): $(SRCS) $(TEST_SRC) $(HEADER) $(INTERNAL_HDRS) $(GEN_HDRS)
	$(CXX) $(TEST_CXXFLAGS) $(EXTRA_TEST_CXXFLAGS) $(SRCS) $(TEST_SRC) -o $(TEST_BIN) -lm

test: $(TEST_BIN)
	./$(TEST_BIN)

# Warning gate. CI's `cpp` job runs this instead of plain `test`, so a new
# implicit conversion or unused parameter fails the build rather than scrolling
# past. Rebuilds from scratch because -Werror only applies to recompiled TUs.
test-werror:
	@rm -f $(TEST_BIN)
	@$(MAKE) --no-print-directory test EXTRA_TEST_CXXFLAGS="-Werror $(EXTRA_TEST_CXXFLAGS)"

# Host-only sanitizers. Not part of the default PR gate (the instrumented binary
# is several times slower) and never applied to the shipped .wasm — run it when
# touching pointer arithmetic in the bulk/LUT kernels:
#   make -C cpp test-asan
$(TEST_ASAN_BIN): $(SRCS) $(TEST_SRC) $(HEADER) $(INTERNAL_HDRS) $(GEN_HDRS)
	$(CXX) $(TEST_CXXFLAGS) -g -fsanitize=address,undefined -fno-omit-frame-pointer \
	  $(SRCS) $(TEST_SRC) -o $(TEST_ASAN_BIN) -lm

test-asan: $(TEST_ASAN_BIN)
	./$(TEST_ASAN_BIN)

# -Werror always: these only run where emsdk is installed (CI's `wasm` job and
# local runs), and a SIMD-only warning has nowhere else to fail.
$(SIMD_TEST_JS): $(SRCS) $(TEST_SRC) $(HEADER) $(INTERNAL_HDRS) $(GEN_HDRS) Makefile
	$(EMXX) $(EMTEST_FLAGS) -Werror $(SRCS) $(TEST_SRC) -o $@

$(PARITY_JS): $(SRCS) $(PARITY_SRCS) $(PARITY_HDRS) $(HEADER) $(INTERNAL_HDRS) $(GEN_HDRS) Makefile
	$(EMXX) $(EMTEST_FLAGS) -Werror $(SRCS) $(PARITY_SRCS) -o $@

test-simd: $(SIMD_TEST_JS)
	$(NODE) $(SIMD_TEST_JS)
	@$(MAKE) --no-print-directory test-parity

test-parity: $(PARITY_JS)
	$(NODE) $(PARITY_JS)

# Write compile_commands.json for clangd. Gitignored: it embeds absolute paths.
# The flags come from this Makefile, so the database cannot drift from the build:
# engine TUs get a wasm32 + -msimd128 entry when $EMSDK is set (so clangd sees
# the SIMD blocks too), the host entry otherwise.
compile-commands:
	@if [ -z "$(NODE)" ]; then \
	  echo "❌  node not found on PATH — cannot write compile_commands.json"; \
	  exit 1; \
	fi
	@$(NODE) ../scripts/gen-compile-commands.mjs \
	  --host-cxx='$(CXX)' --host-flags='$(TEST_CXXFLAGS)' --wasm-flags='$(WASM_CXXFLAGS)' \
	  --engine='$(SRCS)' --host-only='$(TEST_SRC)' --wasm-only='$(PARITY_SRCS)'

# Ensure EXPORTED_FUNCS and the header's prototypes match exactly, both ways.
# Prototypes are `<return type> <name>(` lines at column 0. An empty parse is a
# failure, not a pass, so restyling the header cannot make this check vacuous
# again (the old column-0-name regex matched none of them and always passed).
verify-exports:
	@header=$$(sed -nE 's/^[A-Za-z_][A-Za-z0-9_ ]*[ *]+([A-Za-z_][A-Za-z0-9_]*)\(.*/\1/p' $(HEADER)); \
	if [ -z "$$header" ]; then \
	  echo "❌  no prototypes parsed from $(HEADER) — verify-exports would be vacuous"; exit 1; \
	fi; \
	exports=",$$(echo '$(EXPORTED_FUNCS)' | tr -d ' '),"; \
	missing=""; \
	for fn in $$header; do \
	  case "$$exports" in *",_$$fn,"*) ;; *) missing="$$missing $$fn" ;; esac; \
	done; \
	extra=""; \
	for sym in $$(echo "$$exports" | tr ',' ' '); do \
	  case "$$sym" in _malloc|_free) continue ;; esac; \
	  echo "$$header" | grep -qx "$${sym#_}" || extra="$$extra $$sym"; \
	done; \
	if [ -n "$$missing$$extra" ]; then \
	  [ -z "$$missing" ] || echo "❌  in $(HEADER) but not EXPORTED_FUNCS:$$missing"; \
	  [ -z "$$extra" ] || echo "❌  in EXPORTED_FUNCS but not $(HEADER):$$extra"; \
	  exit 1; \
	fi; \
	echo "✅  $$(echo "$$header" | wc -l | tr -d ' ') exports match $(HEADER)"
