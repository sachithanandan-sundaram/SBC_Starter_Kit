#!/usr/bin/env python3
"""
inference_runner.py
-------------------
Standalone inference process — called as a subprocess by ai_inference.py.
Completely fresh Python process — no inherited GStreamer state from parent.

Usage: python3 inference_runner.py <network_yaml> <frames_dir> <output_pipe>
"""

import os, sys, time, cv2

os.environ.setdefault("AXELERA_FRAMEWORK", "/home/voyager-sdk")
os.environ["GST_PLUGIN_FEATURE_RANK"] = "kmssink:0,waylandsink:0,ximagesink:0,xvimagesink:0"
os.environ["GST_GL_PLATFORM"]         = "egl"
os.environ["GST_GL_XINITTHREADS"]     = "0"
os.environ.pop("DISPLAY", None)

network_yaml = sys.argv[1]
frames_dir   = sys.argv[2]
# Output: write JPEG frames to stdout, separated by length prefix

from axelera.app.stream import create_inference_stream
import wginference

COCO_CLASS_MAP = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 4: "airplane",
    5: "bus", 6: "train", 7: "truck", 8: "boat", 9: "traffic light",
    10: "fire hydrant", 11: "stop sign", 12: "parking meter", 13: "bench",
    14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep", 19: "cow",
    20: "elephant", 21: "bear", 22: "zebra", 23: "giraffe", 24: "backpack",
    25: "umbrella", 26: "handbag", 27: "tie", 28: "suitcase", 29: "frisbee",
    30: "skis", 31: "snowboard", 32: "sports ball", 33: "kite",
    34: "baseball bat", 35: "baseball glove", 36: "skateboard", 37: "surfboard",
    38: "tennis racket", 39: "bottle", 40: "wine glass", 41: "cup",
    42: "fork", 43: "knife", 44: "spoon", 45: "bowl", 46: "banana",
    47: "apple", 48: "sandwich", 49: "orange", 50: "broccoli", 51: "carrot",
    52: "hot dog", 53: "pizza", 54: "donut", 55: "cake", 56: "chair",
    57: "couch", 58: "potted plant", 59: "bed", 60: "dining table",
    61: "toilet", 62: "tv", 63: "laptop", 64: "mouse", 65: "remote",
    66: "keyboard", 67: "cell phone", 68: "microwave", 69: "oven",
    70: "toaster", 71: "sink", 72: "refrigerator", 73: "book", 74: "clock",
    75: "vase", 76: "scissors", 77: "teddy bear", 78: "hair drier",
    79: "toothbrush",
}

wginference.set_class_map(COCO_CLASS_MAP)

out = sys.stdout.buffer

stream = create_inference_stream(
    network=network_yaml,
    sources=[frames_dir],
    pipe_type="gst",
    specified_frame_rate=-1,
)

for fr in stream:
    if fr is None or fr.image is None:
        continue

    bgr = fr.image.asarray('BGR').copy()
    bgr, _, _ = wginference.draw_overlays_bgr(bgr, fr.meta)

    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        continue

    jpeg = buf.tobytes()
    # Write 4-byte length prefix then JPEG bytes
    out.write(len(jpeg).to_bytes(4, 'big'))
    out.write(jpeg)
    out.flush()