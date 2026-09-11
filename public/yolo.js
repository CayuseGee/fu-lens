// 符镜 · 前端本地推理（onnxruntime-web / WASM）
// 在浏览器中直接运行 Mahjong-YOLO nano（YOLOv11n ONNX），支持完全离线识别。
// 依赖：<script src="/vendor/ort.min.js"> 全局 ort；模型 /models/nano/mahjong-yolon-best.onnx
export const YOLO_ACCEPT_CONF = 0.35; // 与后端一致：低于此置信度不入库，标注图标红
export const YOLO_MIN_CONF = 0.10;
export const YOLO_MAX_CONF = 0.90;

export function normalizeAcceptConfidence(value) {
  if (typeof value !== "number" && typeof value !== "string") return YOLO_ACCEPT_CONF;
  if (typeof value === "string" && !value.trim()) return YOLO_ACCEPT_CONF;
  const number = Number(value);
  return Number.isFinite(number) && number >= YOLO_MIN_CONF && number <= YOLO_MAX_CONF
    ? Math.round(number * 100) / 100 : YOLO_ACCEPT_CONF;
}

export function detectionFloor(acceptConf) {
  return Math.min(0.25, normalizeAcceptConfidence(acceptConf));
}

// 静态表为 37 项，与模型 ONNX metadata 一致（无 UNKNOWN，0m/0p/0s 赤5 在末尾）
const CLASS_NAMES = [
  "1m", "1p", "1s", "1z", "2m", "2p", "2s", "2z",
  "3m", "3p", "3s", "3z", "4m", "4p", "4s", "4z",
  "5m", "5p", "5s", "5z", "6m", "6p", "6s", "6z",
  "7m", "7p", "7s", "7z", "8m", "8p", "8s",
  "9m", "9p", "9s", "0m", "0p", "0s",
];

// YOLO 类别 → 项目牌码（0m/0p/0s 赤5 记为普通 5）
function toTileCode(cls) {
  if (cls === "UNKNOWN") return null;
  const rank = cls.slice(0, -1) === "0" ? "5" : cls.slice(0, -1);
  return cls.slice(-1).toLowerCase() + rank;
}

function namesFromSession(session) {
  try {
    const raw = session.metadata?.customMetadataMap?.names;
    if (raw) {
      // 元数据格式如 {0: '1m', 1: '1p', ...}：key 补引号后解析
      const fixed = raw.replace(/([{,]\s*)(\d+)\s*:/g, '$1"$2":').replace(/'/g, '"');
      const d = JSON.parse(fixed);
      const keys = Object.keys(d).map(Number).sort((a, b) => a - b);
      if (keys.length) return keys.map((k) => d[k]);
    }
  } catch { /* 忽略，退回静态表 */ }
  return CLASS_NAMES;
}

let sessionPromise = null;
let loadedNames = null;
let runtimePromise = null;

export function isAndroidApp() {
  return globalThis.location?.origin === "https://appassets.androidplatform.net";
}

async function loadRuntime() {
  if (!runtimePromise) {
    // ORT 1.21's threaded WASM allocates shared memory even with numThreads=1.
    // The bundled Android runtime uses the real single-thread WASM builds.
    const source = isAndroidApp() ? "/vendor/ort-1.17.3/ort.wasm.min.js" : "/vendor/ort.min.js";
    runtimePromise = !isAndroidApp() && globalThis.ort ? Promise.resolve(globalThis.ort)
      : new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = source;
        script.onload = () => { script.remove(); resolve(globalThis.ort); };
        script.onerror = () => { script.remove(); reject(new Error(`运行时资源读取失败：${source}`)); };
        document.head.append(script);
      });
  }
  return runtimePromise;
}

// 加载模型（惰性单例；模型经 Service Worker 缓存后可离线加载）
export function loadYoloModel() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const runtime = await loadRuntime();
      if (!runtime) throw new Error("onnxruntime-web 未加载");
      runtime.env.wasm.wasmPaths = new URL(isAndroidApp() ? "/vendor/ort-1.17.3/" : "/vendor/", location.href).href;
      runtime.env.wasm.numThreads = 1;
      runtime.env.wasm.proxy = false;
      const response = await fetch("/models/nano/mahjong-yolon-best.onnx");
      if (!response.ok) throw new Error(`模型资源读取失败：HTTP ${response.status}`);
      const model = new Uint8Array(await response.arrayBuffer());
      if (!model.byteLength) throw new Error("模型资源为空");
      const session = await runtime.InferenceSession.create(model, { executionProviders: ["wasm"] });
      loadedNames = namesFromSession(session);
      return session;
    })().catch((error) => {
      sessionPromise = null;
      runtimePromise = null;
      loadedNames = null;
      // ORT also caches failed backend initialization internally; retry with a fresh runtime.
      globalThis.ort = undefined;
      throw new Error(`本地模型初始化失败：${error.message || error}`, { cause: error });
    });
  }
  return sessionPromise;
}

// 图片 dataURL → 640x640 letterbox 张量 [1,3,640,640]
async function letterboxTensor(dataUrl, size = 640) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const nw = Math.round(img.naturalWidth * scale);
  const nh = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#727272"; // 114
  ctx.fillRect(0, 0, size, size);
  const padX = (size - nw) >> 1;
  const padY = (size - nh) >> 1;
  ctx.drawImage(img, padX, padY, nw, nh);
  const { data } = ctx.getImageData(0, 0, size, size);
  const tensor = new Float32Array(1 * 3 * size * size);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    tensor[p] = data[i] / 255;
    tensor[size * size + p] = data[i + 1] / 255;
    tensor[2 * size * size + p] = data[i + 2] / 255;
  }
  return { tensor, scale, padX, padY, w: img.naturalWidth, h: img.naturalHeight };
}

function nms(boxes, scores, iouThres) {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];
  while (order.length) {
    const i = order.shift();
    keep.push(i);
    for (let j = order.length - 1; j >= 0; j--) {
      const k = order[j];
      const ix1 = Math.max(boxes[i][0], boxes[k][0]);
      const iy1 = Math.max(boxes[i][1], boxes[k][1]);
      const ix2 = Math.min(boxes[i][2], boxes[k][2]);
      const iy2 = Math.min(boxes[i][3], boxes[k][3]);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaI = (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]);
      const areaK = (boxes[k][2] - boxes[k][0]) * (boxes[k][3] - boxes[k][1]);
      if (inter / Math.max(areaI + areaK - inter, 1e-9) > iouThres) order.splice(j, 1);
    }
  }
  return keep;
}

export function postprocess(output, classNames, acceptConf, floor, scale, padX, padY, w, h) {
  // output: Float32Array [4+nc] * anchors（ORT 输出 [1, 4+nc, 8400] 的 data）
  const nc = classNames.length;
  const anchors = output.length / (4 + nc);
  const detections = [];
  for (let c = 0; c < nc; c++) {
    const classScores = [];
    const boxes = [];
    for (let a = 0; a < anchors; a++) {
      const score = output[(4 + c) * anchors + a];
      if (score < floor) continue;
      const cx = output[a];
      const cy = output[anchors + a];
      const bw = output[2 * anchors + a];
      const bh = output[3 * anchors + a];
      const x1 = (cx - bw / 2 - padX) / scale;
      const y1 = (cy - bh / 2 - padY) / scale;
      const x2 = (cx + bw / 2 - padX) / scale;
      const y2 = (cy + bh / 2 - padY) / scale;
      boxes.push([Math.max(0, Math.min(x1, w)), Math.max(0, Math.min(y1, h)), Math.max(0, Math.min(x2, w)), Math.max(0, Math.min(y2, h))]);
      classScores.push(score);
    }
    if (!classScores.length) continue;
    for (const idx of nms(boxes, classScores, 0.45)) {
      const cls = classNames[c];
      detections.push({
        class: cls,
        tile: toTileCode(cls),
        confidence: classScores[idx],
        bbox: boxes[idx].map((v) => Math.round(v * 10) / 10),
      });
    }
  }
  // 跨类合并（同位置多类别竞争只留最高分）
  detections.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const d of detections) {
    const dup = kept.some((k) => {
      const ix1 = Math.max(d.bbox[0], k.bbox[0]);
      const iy1 = Math.max(d.bbox[1], k.bbox[1]);
      const ix2 = Math.min(d.bbox[2], k.bbox[2]);
      const iy2 = Math.min(d.bbox[3], k.bbox[3]);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const area = (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]);
      return inter / Math.max(area, 1e-9) > 0.8;
    });
    if (!dup) kept.push(d);
  }
  const accepted = kept.filter((d) => d.confidence >= acceptConf);
  const low = kept.filter((d) => d.confidence < acceptConf);
  accepted.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  low.sort((a, b) => b.confidence - a.confidence);
  return { accepted, low };
}

// 前端识别：dataUrl → { model, latency_ms, accept_threshold, accepted, lowConfidence, count, low_count }
export async function detectLocal(dataUrl, acceptConf = YOLO_ACCEPT_CONF) {
  acceptConf = normalizeAcceptConfidence(acceptConf);
  const session = await loadYoloModel();
  const { tensor, scale, padX, padY, w, h } = await letterboxTensor(dataUrl);
  const start = performance.now();
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", tensor, [1, 3, 640, 640]) };
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]].data;
  const latencyMs = performance.now() - start;
  const { accepted, low } = postprocess(output, loadedNames, acceptConf, detectionFloor(acceptConf), scale, padX, padY, w, h);
  return {
    model: "mahjong-yolon-best (YOLOv11n) · onnxruntime-web",
    latency_ms: Math.round(latencyMs * 10) / 10,
    accept_threshold: acceptConf,
    accepted,
    lowConfidence: low,
    count: accepted.length,
    low_count: low.length,
  };
}

// 前端生成标注图：绿框=入库，红框=未识别
export async function annotateLocal(dataUrl, accepted, low) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.lineWidth = Math.max(3, canvas.width / 300);
  ctx.font = `${Math.max(16, canvas.width / 40)}px "Microsoft YaHei", sans-serif`;
  const draw = (det, color, prefix = "") => {
    const [x1, y1, x2, y2] = det.bbox;
    ctx.strokeStyle = color;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = `${prefix}${det.class} ${det.confidence.toFixed(2)}`;
    const tw = ctx.measureText(label).width;
    const th = Math.max(16, canvas.width / 40);
    ctx.fillStyle = color;
    ctx.fillRect(x1, Math.max(0, y1 - th - 6), tw + 8, th + 4);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x1 + 4, Math.max(th, y1 - 4));
  };
  for (const det of accepted) draw(det, "#2e9e5b");
  for (const det of low) draw(det, "#d32f2f", "?");
  return canvas.toDataURL("image/jpeg", 0.88);
}
