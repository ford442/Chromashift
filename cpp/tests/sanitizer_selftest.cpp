/**
 * Sanitizer self-test: commits the defects `make test-asan` exists to catch, so
 * `make test-sanitizer-selftest` can prove the sanitizers are armed to FAIL the
 * run rather than print and carry on.
 *
 * `overflow`  signed integer overflow - UBSan, which only aborts under
 *             -fno-sanitize-recover=all (its default is report-and-continue,
 *             exit 0, which is how `test-asan` once passed over real UB).
 * `oob`       one-past-the-end heap write - ASan.
 * `simd-oob`  a 16-byte `v128.load` that runs past the end of a heap block - ASan
 *             under emcc (`make test-simd-asan`). Only built with -msimd128.
 * `clean`     none of them; must exit 0, so a broken harness cannot pass as "armed".
 *
 * The inputs come from argv and go through volatile so the optimiser can fold
 * neither the overflow away nor the allocation.
 */

#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if defined(__wasm_simd128__)
#  include <wasm_simd128.h>
#endif

int main(int argc, char** argv)
{
    const char* mode = argc > 1 ? argv[1] : "clean";

    if (std::strcmp(mode, "overflow") == 0) {
        volatile int big = INT_MAX;
        volatile int one = 1;
        const int wrapped = big + one;  // signed overflow: undefined behaviour
        std::printf("overflow survived: %d\n", wrapped);
        return EXIT_SUCCESS;
    }

    if (std::strcmp(mode, "oob") == 0) {
        volatile std::size_t n = 8;
        char* heap = static_cast<char*>(std::malloc(n));
        heap[n] = 1;  // one past the end
        std::printf("oob survived\n");
        std::free(heap);
        return EXIT_SUCCESS;
    }

#if defined(__wasm_simd128__)
    if (std::strcmp(mode, "simd-oob") == 0) {
        // 5 floats = 20 bytes; the load at element 4 reads bytes 16..31. Stored
        // back and printed so the optimiser cannot narrow it to the one valid lane.
        volatile std::size_t n = 5;
        float* heap = static_cast<float*>(std::malloc(n * sizeof(float)));
        for (std::size_t i = 0; i < n; ++i) heap[i] = 1.0f;
        wasm_v128_store(heap, wasm_v128_load(heap + 4));
        std::printf("simd-oob survived: %f\n", static_cast<double>(heap[0]));
        std::free(heap);
        return EXIT_SUCCESS;
    }
#endif

    return EXIT_SUCCESS;
}
