#!/usr/bin/env python3
"""
符镜 · 本地麻将牌检测（Mahjong-YOLO nano, YOLOv11n ONNX）
========================================================
本地客户端部署：使用 onnxruntime 加载 mahjong-yolon-best.onnx，
对图片做 640x640 letterbox 预处理，输出 YOLO 解码 + NMS 后的检测结果 JSON。

置信度分级：
  accepted      置信度 >= --accept（默认 0.35）→ 可信牌，用于牌库录入
  lowConfidence --floor <= 置信度 < --accept → 未识别牌，标注图中标红，供人工校对

用法:
  python yolo-detect.py <图片路径> [--accept 0.5] [--floor 0.25] [--iou 0.45]
                   [--out 标注图.png] [--markup-b64] [--model 路径]

输出(stdout, JSON):
  {"model": "...", "classes_n": 37, "latency_ms": 12.3,
   "accepted": [{"class":"1m","tile":"m1","confidence":0.91,"bbox":[x1,y1,x2,y2]}],
   "lowConfidence": [...],
   "annotated_b64": "data:image/jpeg;base64,..."(仅 --markup-b64)}
"""
import argparse
import ast
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

# Mahjong-YOLO 训练类别顺序（与仓库 inference_validation.py 一致）
CLASS_NAMES = [
    "1m", "1p", "1s", "1z", "2m", "2p", "2s", "2z",
    "3m", "3p", "3s", "3z", "4m", "4p", "4s", "4z",
    "5m", "5p", "5s", "5z", "6m", "6p", "6s", "6z",
    "7m", "7p", "7s", "7z", "8m", "8p", "8s",
    "9m", "9p", "9s", "UNKNOWN", "0m", "0p", "0s",
]


def names_from_onnx(session):
    """优先从 ONNX 元数据读取真实类别表（如 'names' 元数据缺失再退回静态表）。"""
    meta = session.get_modelmeta().custom_metadata_map
    raw = meta.get("names")
    if raw:
        try:
            d = ast.literal_eval(raw)
            if isinstance(d, dict) and d:
                return [d[k] for k in sorted(d, key=int)]
        except Exception:
            pass
    return CLASS_NAMES


# YOLO 类别 → 符镜项目牌码（m1-m9/p1-p9/s1-s9/z1-z7；0m/0p/0s 赤5 记为普通 5）
def to_tile_code(cls):
    if cls == "UNKNOWN":
        return None
    rank, suit = cls[:-1], cls[-1].lower()
    rank = "5" if rank == "0" else rank  # 赤5 在牌型中等同于 5
    return suit + rank


def letterbox(img: Image.Image, size: int = 640):
    """等比缩放 + 灰边填充到 size x size，返回 (张量, 缩放比, 左填充, 上填充)。"""
    w, h = img.size
    scale = min(size / w, size / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    canvas.paste(resized, (pad_x, pad_y))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    tensor = np.transpose(arr, (2, 0, 1))[None, ...]  # 1,3,640,640
    return tensor, scale, pad_x, pad_y


def nms(boxes: np.ndarray, scores: np.ndarray, iou_thres: float):
    """类别无关 NMS（输入已按类别过滤）。返回保留索引。"""
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_r = (boxes[order[1:], 2] - boxes[order[1:], 0]) * (boxes[order[1:], 3] - boxes[order[1:], 1])
        iou = inter / np.maximum(area_i + area_r - inter, 1e-9)
        order = order[1:][iou <= iou_thres]
    return keep


def postprocess(output: np.ndarray, class_names, floor: float, iou_thres: float, scale, pad_x, pad_y, orig_w, orig_h):
    """YOLOv11 ONNX 输出 [1, 4+nc, 8400] → 检测列表（原图坐标，置信度 >= floor）。"""
    out = output[0].transpose(1, 0)  # [8400, 4+nc]
    boxes = out[:, :4]               # cx, cy, w, h（640 坐标系）
    scores = out[:, 4:]
    # 若类别分数未过 sigmoid（原始 logits 可能 >1），自动补 sigmoid
    if scores.max() > 1.5:
        scores = 1.0 / (1.0 + np.exp(-scores))

    xyxy = np.empty_like(boxes)
    xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2

    detections = []
    for c in range(scores.shape[1]):
        cls_scores = scores[:, c]
        idx = np.where(cls_scores >= floor)[0]
        if idx.size == 0:
            continue
        keep = nms(xyxy[idx], cls_scores[idx], iou_thres)
        for k in keep:
            x1, y1, x2, y2 = xyxy[idx[k]]
            x1 = (x1 - pad_x) / scale
            y1 = (y1 - pad_y) / scale
            x2 = (x2 - pad_x) / scale
            y2 = (y2 - pad_y) / scale
            x1 = max(0.0, min(float(x1), orig_w))
            y1 = max(0.0, min(float(y1), orig_h))
            x2 = max(0.0, min(float(x2), orig_w))
            y2 = max(0.0, min(float(y2), orig_h))
            cls = class_names[c]
            detections.append({
                "class": cls,
                "tile": to_tile_code(cls),
                "confidence": round(float(cls_scores[idx[k]]), 4),
                "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            })
    return detections


def merge_cross_class(detections, overlap=0.8):
    """跨类合并：同一位置被检出多个类别时（IoU 极高的竞争框），只保留置信度最高者。
    按置信度降序贪心；重叠占较小框面积比例 > overlap 视为同一目标。"""
    dets = sorted(detections, key=lambda d: -d["confidence"])
    kept = []
    for d in dets:
        b = d["bbox"]
        dup = False
        for k in kept:
            kk = k["bbox"]
            ix1, iy1 = max(b[0], kk[0]), max(b[1], kk[1])
            ix2, iy2 = min(b[2], kk[2]), min(b[3], kk[3])
            inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
            area = (b[2] - b[0]) * (b[3] - b[1])
            if inter / max(area, 1e-9) > overlap:
                dup = True
                break
        if not dup:
            kept.append(d)
    return kept


def annotate(img: Image.Image, accepted, low, out_path: str = None):
    """绿框 = 可信牌（>=0.5），红框 = 未识别牌（<0.5），返回标注后的 PIL 图像。"""
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)
    except Exception:
        font = ImageFont.load_default()

    def draw_box(det, color, prefix=""):
        x1, y1, x2, y2 = det["bbox"]
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        label = f"{prefix}{det['class']} {det['confidence']:.2f}"
        tw, th = draw.textbbox((0, 0), label, font=font)[2:]
        draw.rectangle([x1, max(0, y1 - th - 6), x1 + tw + 6, y1], fill=color)
        draw.text((x1 + 3, max(0, y1 - th - 3)), label, fill="white", font=font)

    for det in accepted:
        draw_box(det, "#2e9e5b")
    for det in low:
        draw_box(det, "#d32f2f", "?")
    if out_path:
        img.save(out_path)
    return img


def markup_b64(img: Image.Image) -> str:
    """标注图 → JPEG base64 data URL（控制体积，白底防透明度问题）。"""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description="Mahjong-YOLO nano 本地检测")
    parser.add_argument("image", help="图片路径")
    parser.add_argument("--accept", type=float, default=0.35, help="可信牌置信度阈值 (默认 0.35)")
    parser.add_argument("--floor", type=float, default=0.25, help="最低检出置信度 (默认 0.25，低于此值丢弃)")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU 阈值 (默认 0.45)")
    parser.add_argument("--out", help="可选：输出标注图路径")
    parser.add_argument("--markup-b64", action="store_true", help="在 JSON 中附带标注图 base64")
    parser.add_argument("--model", default=None, help="模型路径（默认同目录 models/nano/mahjong-yolon-best.onnx）")
    args = parser.parse_args()

    model_path = args.model or str(
        Path(__file__).resolve().parent / "models" / "nano" / "mahjong-yolon-best.onnx"
    )
    if not os.path.exists(model_path):
        print(json.dumps({"error": f"模型不存在: {model_path}"}), file=sys.stderr)
        sys.exit(2)

    img = Image.open(args.image).convert("RGB")
    orig_w, orig_h = img.size

    session = ort.InferenceSession(
        model_path, providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    class_names = names_from_onnx(session)
    tensor, scale, pad_x, pad_y = letterbox(img)

    start = time.perf_counter()
    output = session.run(None, {input_name: tensor})[0]
    latency_ms = (time.perf_counter() - start) * 1000

    classes_n = output.shape[1] - 4
    if classes_n != len(class_names):
        print(json.dumps({"error": f"模型类别数 {classes_n} 与类别表 {len(class_names)} 不一致"}), file=sys.stderr)
        sys.exit(2)

    detections = postprocess(output, class_names, min(args.floor, args.accept), args.iou, scale, pad_x, pad_y, orig_w, orig_h)
    detections = merge_cross_class(detections)
    accepted = [d for d in detections if d["confidence"] >= args.accept]
    low = [d for d in detections if d["confidence"] < args.accept]
    # 可信牌按画面位置排序（先行后列），便于人工对照照片校对
    accepted.sort(key=lambda d: (d["bbox"][1], d["bbox"][0]))
    low.sort(key=lambda d: -d["confidence"])

    result = {
        "model": "mahjong-yolon-best (YOLOv11n)",
        "classes_n": classes_n,
        "image": {"w": orig_w, "h": orig_h},
        "latency_ms": round(latency_ms, 1),
        "accept_threshold": args.accept,
        "accepted": accepted,
        "lowConfidence": low,
        "count": len(accepted),
        "low_count": len(low),
    }
    if args.out or args.markup_b64:
        marked = annotate(img, accepted, low, args.out)
        if args.markup_b64:
            result["annotated_b64"] = markup_b64(marked)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
