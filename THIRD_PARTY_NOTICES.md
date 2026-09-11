# Third-party components

The root MIT license applies to the original Fu Lens code. Third-party components retain their own copyright and license notices.

## Mahjong-YOLO model

- Source: https://github.com/nikmomo/Mahjong-YOLO
- Inspected upstream revision: `28ffceed232ad95fd019c47a6c51ae7c78791a0e`.
- Files: `models/nano/mahjong-yolon-best.onnx` and the identical `public/models/nano/` copy.
- Upstream declares MIT, Copyright (c) 2024 Shin Zhang. See [license](third_party/Mahjong-YOLO-LICENSE).
- ONNX SHA-256: `3C7732C022D41C1A3F48CEA931CE626416D92486AB5B86692312941D0CC22226`.
- The model has 37 classes including red fives. No upstream accuracy benchmark is claimed as Fu Lens accuracy.

The upstream project uses Ultralytics tooling for training. This release does not distribute that training stack or dataset. Their separate terms and any dataset rights are not replaced by this repository's MIT license. Users planning retraining or broader redistribution should review the relevant upstream terms independently.

## ONNX Runtime Web

- Source: https://github.com/microsoft/onnxruntime
- PWA assets under `public/vendor/`: version 1.21.0.
- Android assets under `public/vendor/ort-1.17.3/`: version 1.17.3; download provenance is also included there.
- MIT, Copyright (c) Microsoft Corporation.
- [License](third_party/ONNX-Runtime-LICENSE), [1.21.0 third-party notices](third_party/ONNX-Runtime-1.21.0-ThirdPartyNotices.txt), [1.17.3 third-party notices](third_party/ONNX-Runtime-1.17.3-ThirdPartyNotices.txt).

Keep these notices with redistributed copies of the corresponding components. Optional Python packages and Ollama installations have their own licenses and are not bundled here.
