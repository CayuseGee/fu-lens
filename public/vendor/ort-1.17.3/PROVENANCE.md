# Android WASM Compatibility Runtime

Version: Microsoft ONNX Runtime Web 1.17.3, MIT license (see LICENSE).

Downloaded unmodified from the pinned jsDelivr distribution:

- https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.wasm.min.js
- https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-simd.wasm
- https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm.wasm
- License: https://raw.githubusercontent.com/microsoft/onnxruntime/v1.17.3/LICENSE

These are vendored static assets, not npm package dependencies. Only the APK
origin selects this runtime. With numThreads=1 it uses a genuinely unshared
WASM memory, with a scalar fallback when SIMD is unavailable. The existing
PWA runtime remains 1.21.0. Both paths use the same trusted bundled ONNX model;
user-supplied ONNX models are not accepted.
