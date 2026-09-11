// 符镜 · 本地服务器（Node.js ≥20，零依赖，ESM）
// 启动：npm start / node server.mjs  → http://localhost:4173
// API：
//   GET  /                   静态页面（public/，PWA 离线资源）
//   GET  /api/health         健康检查：{ yolo: { configured, acceptConfidence }, ollama: {...} }
//   POST /api/recognize      图片 base64 识别：前端失败时的回退路径。
//                            主：Python yolo-detect.py（Mahjong-YOLO nano ONNX，阈值 0.35）
//                            兜底：本地 Ollama（qwen2.5vl:7b）—— 无任何云端 LLM API
//   POST /api/detect         仅 YOLO 检测（标注图 base64 返回）
// 约定：静态文件响应 Cache-Control: no-cache（在线永远最新，离线由 SW 缓存兜底）
import { createServer } from "node:http";
import { readFile, stat, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHand } from "./public/fu.js";
import { YOLO_ACCEPT_CONF, normalizeAcceptConfidence, detectionFloor } from "./public/yolo.js";

const root = resolve(fileURLToPath(new URL("./public", import.meta.url)));
const port = Number(process.env.PORT) || 4173;
const ollamaBase = process.env.OLLAMA_BASE || "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:7b";
const ollamaTimeoutMs = 120_000;
let ollamaCache = { ok: false, at: 0 };

// 识别策略：仅本地 Mahjong-YOLO nano（YOLOv11n ONNX）；Ollama 端口保留为本地兜底，
// 不接入任何云端大模型 API 做线上图像分析。
const yoloScript = resolve(fileURLToPath(new URL("./yolo-detect.py", import.meta.url)));
const yoloModelPath = resolve(fileURLToPath(new URL("./models/nano/mahjong-yolon-best.onnx", import.meta.url)));
const pythonCmd = process.env.PYTHON || "python";

async function ollamaAvailable() {
  if (Date.now() - ollamaCache.at < 15_000) return ollamaCache.ok;
  try {
    const response = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(2500) });
    ollamaCache = { ok: response.ok, at: Date.now() };
  } catch {
    ollamaCache = { ok: false, at: Date.now() };
  }
  return ollamaCache.ok;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const ollamaSchema = {
  type: "object",
  required: ["handType", "winMethod", "closed", "waitType", "pair", "groups", "confidence"],
  properties: {
    handType: { type: "string", enum: ["regular", "pinfu", "chiitoitsu"] },
    winMethod: { type: "string", enum: ["ron", "tsumo"] },
    closed: { type: "boolean" },
    waitType: { type: "string", enum: ["ryanmen", "shanpon", "tanki", "kanchan", "penchan"] },
    pair: {
      type: "object",
      required: ["tile", "dragon", "seatWind", "roundWind"],
      properties: {
        tile: { type: "string" },
        dragon: { type: "boolean" },
        seatWind: { type: "boolean" },
        roundWind: { type: "boolean" },
      },
    },
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "open", "terminalOrHonor", "tiles"],
        properties: {
          type: { type: "string", enum: ["sequence", "triplet", "quad"] },
          open: { type: "boolean" },
          terminalOrHonor: { type: "boolean" },
          tiles: { type: "array", items: { type: "string" } },
        },
      },
    },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
};

const recognitionPrompt = `你是日本立直麻将牌面读取器。读取照片中的和牌，并返回结构化牌姿，不计算番数或符数。
牌码：m1-m9=万子，p1-p9=筒子，s1-s9=索子，z1-z7=东南西北白发中。
识别四个面子和一个雀头；横置或明显分开的副露牌组标记 open=true。暗杠标记 open=false。
只有清楚满足七对子时 handType=chiitoitsu。只有确定为门清、四顺子、非役牌雀头、两面听时才用 pinfu，否则用 regular。
照片通常不能证明荣和/自摸、场风、自风与最后一张牌。无法确认时 winMethod 用 ron，相关雀头布尔值用 false，并在 notes 用简短中文指出需要人工校对的项目。
terminalOrHonor 在刻子或杠子由一九牌或字牌组成时为 true；顺子始终为 false。confidence 表示整手结构的识别可信度。
只输出一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字或解释。`;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("IMAGE_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const validTile = /^(?:[mps][1-9]|z[1-7])$/;

// 对本地模型输出做结构校验（normalizeHand 会静默吞掉非法值，可能产生空组）
function validateRecognizedHand(hand) {
  if (hand.handType === "chiitoitsu") {
    if (hand.groups.length !== 0) throw new Error("七对子不应含面子组");
    return;
  }
  if (hand.groups.length !== 4) throw new Error(`应有 4 组面子，实际 ${hand.groups.length} 组`);
  const expectedTiles = { sequence: 3, triplet: 3, quad: 4 };
  for (const group of hand.groups) {
    if (!validTile.test(group.tiles?.[0] || "")) throw new Error("存在非法牌码");
    const expected = expectedTiles[group.type];
    if (expected && group.tiles.length !== expected) {
      throw new Error(`${group.type} 应有 ${expected} 张，实际 ${group.tiles.length} 张`);
    }
  }
  if (!validTile.test(hand.pair?.tile || "")) throw new Error("雀头牌码非法");
  const quads = hand.groups.filter((group) => group.type === "quad").length;
  const total = hand.groups.reduce((sum, group) => sum + group.tiles.length, 0) + 2;
  if (total !== 14 + quads) throw new Error(`总牌数 ${total} 与和牌型不符（应 ${14 + quads}）`);
}

async function recognizeWithOllama(imageBase64) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${ollamaBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{
          role: "user",
          content: recognitionPrompt,
          images: [imageBase64],
        }],
        stream: false,
        format: ollamaSchema,
        options: { temperature: attempt === 0 ? 0.1 : 0 },
      }),
      signal: AbortSignal.timeout(ollamaTimeoutMs),
    });
    const payload = await response.json();
    if (!response.ok) {
      const message = payload.error || "";
      if (message.includes("model")) {
        throw new Error(`本地模型 ${ollamaModel} 未安装，请先运行：ollama pull ${ollamaModel}`);
      }
      throw new Error(`Ollama 返回错误：${message || response.status}`);
    }
    const content = payload.message?.content || "";
    try {
      const hand = normalizeHand(JSON.parse(content));
      validateRecognizedHand(hand);
      return hand;
    } catch (error) {
      lastError = error.message;
    }
  }
  throw new Error(`识别结果无法解析为有效和牌：${lastError}`);
}

async function detectWithYolo(imageBase64, { markup = false, acceptConfidence = YOLO_ACCEPT_CONF } = {}) {
  const threshold = normalizeAcceptConfidence(acceptConfidence);
  if (!(await stat(yoloModelPath)).isFile()) {
    throw new Error("YOLO 模型未安装，请先放置 models/nano/mahjong-yolon-best.onnx");
  }
  const tmpFile = join(tmpdir(), `fujing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  await writeFile(tmpFile, Buffer.from(imageBase64, "base64"));
  const args = [yoloScript, tmpFile, "--accept", String(threshold), "--floor", String(detectionFloor(threshold)), "--iou", "0.45"];
  if (markup) args.push("--markup-b64");
  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(pythonCmd, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) {
          try { resolvePromise(JSON.parse(stdout)); }
          catch { rejectPromise(new Error(`YOLO 输出解析失败: ${stderr.trim() || stdout.slice(0, 200)}`)); }
        } else {
          rejectPromise(new Error(stderr.trim() || `YOLO 退出码 ${code}`));
        }
      });
    });
    return result;
  } finally {
    rm(tmpFile, { force: true }).catch(() => {});
  }
}

async function recognize(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    json(res, error.message === "IMAGE_TOO_LARGE" ? 413 : 400, {
      error: error.message === "IMAGE_TOO_LARGE" ? "照片过大" : "请求格式无效",
    });
    return;
  }

  if (typeof body.image !== "string" || !/^data:image\/(?:jpeg|png|webp);base64,/.test(body.image)) {
    json(res, 400, { error: "缺少有效的照片数据" });
    return;
  }
  const imageBase64 = body.image.slice(body.image.indexOf(",") + 1);

  try {
    // 主路径：本地 Mahjong-YOLO nano 检测（不依赖任何线上服务）
    try {
      const result = await detectWithYolo(imageBase64, { markup: true, acceptConfidence: body.accept_threshold });
      const pool = result.accepted
        .map((detection) => detection.tile)
        .filter((tile) => tile && /^(?:[mps][1-9]|z[1-7])$/.test(tile));
      const notes = result.low_count
        ? `红框标注的 ${result.low_count} 张牌置信度低于 ${result.accept_threshold}，未加入牌库，请人工校对`
        : `全部 ${result.count} 张牌置信度达标，已加入牌库`;
      json(res, 200, {
        backend: "yolo-nano",
        pool,
        accepted: result.accepted,
        lowConfidence: result.lowConfidence,
        annotated: result.annotated_b64 || "",
        model: result.model,
        latency_ms: result.latency_ms,
        accept_threshold: result.accept_threshold,
        confidence: result.accepted.length
          ? Math.min(...result.accepted.map((detection) => detection.confidence))
          : 0,
        notes,
      });
      return;
    } catch (yoloError) {
      // 兜底：保留的本地 Ollama 端口（qwen2.5vl 视觉模型），仍不涉及云端 API
      if (!(await ollamaAvailable())) throw yoloError;
      console.error("YOLO detection failed, falling back to Ollama:", yoloError.message);
      const hand = await recognizeWithOllama(imageBase64);
      json(res, 200, { hand, backend: "ollama" });
    }
  } catch (error) {
    console.error("Recognition error:", error.message);
    json(res, 502, { error: `识别失败：${error.message}` });
  }
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = resolve(join(root, relativePath));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, "index.html");
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      // no-cache：在线始终校验最新（离线由 Service Worker 缓存兜底）
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(self)",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/api/recognize" && req.method === "POST") {
    await recognize(req, res);
    return;
  }
  if (pathname === "/api/detect" && req.method === "POST") {
    try {
      const body = await readJson(req);
      if (typeof body.image !== "string" || !/^data:image\/(?:jpeg|png|webp);base64,/.test(body.image)) {
        json(res, 400, { error: "缺少有效的照片数据" });
        return;
      }
      const imageBase64 = body.image.slice(body.image.indexOf(",") + 1);
      const result = await detectWithYolo(imageBase64, { acceptConfidence: body.accept_threshold });
      json(res, 200, { ...result, backend: "yolo-nano" });
    } catch (error) {
      console.error("YOLO detect error:", error.message);
      json(res, 502, { error: `本地检测失败：${error.message}` });
    }
    return;
  }
  if (pathname === "/api/health" && req.method === "GET") {
    const ollamaUp = await ollamaAvailable();
    let yoloUp = false;
    try { yoloUp = (await stat(yoloModelPath)).isFile(); } catch { /* 模型未下载 */ }
    json(res, 200, {
      ok: true,
      recognition: yoloUp ? "yolo-nano" : ollamaUp ? "ollama" : null,
      yolo: { configured: yoloUp, model: "mahjong-yolon-best (YOLOv11n)", acceptConfidence: YOLO_ACCEPT_CONF },
      ollama: { configured: ollamaUp, model: ollamaUp ? ollamaModel : null },
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD, POST" }).end();
    return;
  }
  await serveStatic(req, res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`符镜已启动：http://localhost:${port}`);
  console.log(`识别后端：本地 Mahjong-YOLO nano（置信度阈值 ${YOLO_ACCEPT_CONF}）${process.env.OLLAMA_BASE ? `，Ollama 兜底 ${process.env.OLLAMA_BASE}` : ""}`);
});
