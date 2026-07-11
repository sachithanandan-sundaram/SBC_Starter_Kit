#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wginference.py - Voyager SDK 1.4 Compatible Inference Module
- Dynamic class mapping for multiple models
- Ultralytics-style detection overlays
- Parking ROI visualization
- Optimized for performance and readability
"""

import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any, Tuple, List
from dataclasses import dataclass

import numpy as np
import cv2

# ============================================================================
# GLOBAL STATE MANAGEMENT
# ============================================================================

_CURRENT_CLASS_MAP: Dict[int, str] = {}
_PARKING_ROI_DATA: Optional[Dict[str, Any]] = None

# Ultralytics-inspired color palette for detections
_PALETTE: Tuple[Tuple[int, int, int], ...] = (
    (255, 56, 56), (255, 157, 151), (255, 112, 31), (255, 178, 29),
    (207, 210, 49), (72, 249, 10), (146, 204, 23), (61, 219, 134),
    (26, 147, 52), (0, 212, 187), (44, 153, 168), (0, 194, 255),
    (52, 69, 147), (100, 115, 255), (0, 24, 236), (132, 56, 255),
    (82, 0, 133), (203, 56, 255), (255, 149, 200), (255, 55, 199),
)

_MAX_DEPTH: int = 6


# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class Detection:
    """Represents a single object detection."""
    class_id: Optional[int]
    class_name: Optional[str]
    confidence: Optional[float]
    bbox: Dict[str, int]  # {"x1": int, "y1": int, "x2": int, "y2": int}


# ============================================================================
# CLASS MAP MANAGEMENT
# ============================================================================

def set_class_map(class_map: Dict[int, str]) -> None:
    """
    Set the current class map for this inference session.

    Args:
        class_map: Dictionary mapping class IDs to class names
    """
    global _CURRENT_CLASS_MAP
    _CURRENT_CLASS_MAP = class_map.copy()


def get_class_map() -> Dict[int, str]:
    """
    Get the current class map.

    Returns:
        Dictionary mapping class IDs to class names
    """
    return _CURRENT_CLASS_MAP.copy()


# ============================================================================
# PARKING ROI MANAGEMENT
# ============================================================================

def load_parking_roi(roi_json_path: str) -> bool:
    """
    Load parking ROI data from JSON file.

    Args:
        roi_json_path: Path to the ROI JSON file

    Returns:
        True if loaded successfully, False otherwise
    """
    global _PARKING_ROI_DATA
    try:
        import json
        with open(roi_json_path, 'r', encoding='utf-8') as f:
            _PARKING_ROI_DATA = json.load(f)
        return True
    except Exception as e:
        print(f"[ERROR] Failed to load parking ROI from {roi_json_path}: {e}")
        _PARKING_ROI_DATA = None
        return False


def get_parking_roi_data() -> Optional[Dict[str, Any]]:
    """
    Get the loaded parking ROI data.

    Returns:
        Parking ROI data dictionary or None if not loaded
    """
    return _PARKING_ROI_DATA


# ============================================================================
# DETECTION EXTRACTION
# ============================================================================

def extract_class_map_from_meta(meta) -> Dict[int, str]:
    """
    Extract class map from AxMeta object.

    Args:
        meta: AxMeta object from Voyager SDK

    Returns:
        Dictionary mapping class IDs to class names
    """
    meta_map = getattr(meta, "_meta_map", None)
    if not isinstance(meta_map, dict):
        return {}

    model_block = _choose_model_block(meta_map)
    if model_block is None:
        return {}

    # FIX: was referencing undefined 'model_data' — use 'model_block' consistently
    labels = None
    if isinstance(model_block, dict):
        labels = model_block.get("labels") or model_block.get("names")
    else:
        labels = getattr(model_block, "labels", None) or getattr(model_block, "names", None)

    class_map = {}

    if isinstance(labels, dict):
        for k, v in labels.items():
            class_map[int(k)] = str(v)
    elif isinstance(labels, (list, tuple)):
        for i, name in enumerate(labels):
            class_map[i] = str(name)

    return class_map


def extract_detections_from_meta(
    meta,
    class_map: Optional[Dict[int, str]] = None
) -> List[Dict[str, Any]]:
    """
    Extract detections from AxMeta object with proper class mapping.

    Args:
        meta: AxMeta object from Voyager SDK
        class_map: Optional class map (defaults to global class map)

    Returns:
        List of detection dictionaries with class_name, class_id, confidence, bbox
    """
    if meta is None:
        return []

    if class_map is None:
        class_map = get_class_map()

    detections = []

    try:
        meta_map = getattr(meta, "_meta_map", None)
        if not isinstance(meta_map, dict):
            return detections

        # Get first non-system model metadata
        model_meta = _choose_model_block(meta_map)
        if model_meta is None:
            return detections

        # Extract detection arrays
        boxes = _safe_to_numpy(getattr(model_meta, 'boxes', None))
        scores = _safe_to_numpy(getattr(model_meta, 'scores', None))
        class_ids = _safe_to_numpy(getattr(model_meta, 'class_ids', None))

        # Validate boxes shape
        if boxes is None or boxes.ndim != 2 or boxes.shape[1] < 4:
            return detections

        num_detections = boxes.shape[0]

        # Build detections
        for i in range(num_detections):
            bbox = boxes[i][:4].tolist()
            class_id = int(class_ids[i]) if class_ids is not None and len(class_ids) > i else None
            confidence = float(scores[i]) if scores is not None and len(scores) > i else None

            class_name = class_map.get(class_id, f'class_{class_id}') if class_id is not None else None

            detections.append({
                "class_id": class_id,
                "class_name": class_name,
                "confidence": confidence,
                "bbox": {
                    "x1": int(bbox[0]),
                    "y1": int(bbox[1]),
                    "x2": int(bbox[2]),
                    "y2": int(bbox[3])
                }
            })

    except Exception as e:
        print(f"[WARNING] Failed to extract detections: {e}")

    return detections


def _iter_detections(meta):
    """
    Iterator over raw detections from AxMeta object.

    Yields:
        Tuple of (("abs_xyxy", bbox), label_id, score)
    """
    if meta is None:
        return

    meta_map = getattr(meta, "_meta_map", None)
    if not isinstance(meta_map, dict) or not meta_map:
        return

    model_block = _choose_model_block(meta_map)
    if model_block is None:
        return

    # Extract arrays
    boxes = _safe_to_numpy(getattr(model_block, "boxes", None))
    scores = _safe_to_numpy(getattr(model_block, "scores", None))
    class_ids = _safe_to_numpy(getattr(model_block, "class_ids", None))

    if boxes is None or boxes.ndim != 2 or boxes.shape[1] < 4:
        return

    num_detections = boxes.shape[0]

    for i in range(num_detections):
        bbox = boxes[i][:4].tolist()
        score = float(scores[i]) if scores is not None and len(scores) > i else None
        label = int(class_ids[i]) if class_ids is not None and len(class_ids) > i else None

        yield ("abs_xyxy", bbox), label, score


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _safe_to_numpy(obj):
    """Safely convert object to numpy array."""
    if obj is None:
        return None
    try:
        return np.asarray(obj)
    except Exception:
        return None


def _choose_model_block(meta_map: Dict[str, Any]):
    """Select the appropriate model metadata block."""
    # Prefer non-system keys
    for key in meta_map.keys():
        if not str(key).startswith("__"):
            return meta_map[key]

    # Fallback to first key
    for key in meta_map.keys():
        return meta_map[key]

    return None


def _normalize_xyxy(kind_and_box: Tuple[str, List], w: int, h: int) -> Optional[Tuple[int, int, int, int]]:
    """
    Normalize bounding box to absolute pixel coordinates.

    Args:
        kind_and_box: Tuple of (kind, bbox)
        w: Frame width
        h: Frame height

    Returns:
        Tuple of (x1, y1, x2, y2) in absolute coordinates or None
    """
    kind, box = kind_and_box
    if not box or len(box) < 4:
        return None

    x1, y1, x2, y2 = box[:4]

    # Normalized coordinates (0-1 range)
    if x2 <= 1.0 and y2 <= 1.0:
        return (int(x1 * w), int(y1 * h), int((x1 + x2) * w), int((y1 + y2) * h))

    # Semi-normalized (0-2 range)
    if x2 < 2.0 and y2 < 2.0:
        return (int(x1 * w), int(y1 * h), int(x2 * w), int(y2 * h))

    # Width/height format (x1, y1, w, h)
    if x2 < x1 or y2 < y1:
        return (int(x1), int(y1), int(x1 + x2), int(y1 + y2))

    # Absolute coordinates
    return (int(x1), int(y1), int(x2), int(y2))


def _color_for_class(class_id: Optional[int]) -> Tuple[int, int, int]:
    """
    Get color for a given class ID.

    Args:
        class_id: Class ID

    Returns:
        BGR color tuple
    """
    if class_id is None:
        return (0, 255, 0)

    try:
        return _PALETTE[int(class_id) % len(_PALETTE)]
    except Exception:
        return (0, 255, 0)


def _to_plain_json(obj, _depth: int = 0, _max_depth: int = _MAX_DEPTH):
    """
    Recursively convert object to JSON-serializable format.

    Args:
        obj: Object to convert
        _depth: Current recursion depth
        _max_depth: Maximum recursion depth

    Returns:
        JSON-serializable object
    """
    if _depth > _max_depth:
        return f"<{type(obj).__name__}>"

    # Primitives
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj

    # NumPy arrays
    try:
        if hasattr(obj, "__array__") or isinstance(obj, np.ndarray):
            return np.asarray(obj).tolist()
    except Exception:
        pass

    # Dictionaries
    if isinstance(obj, dict):
        return {str(k): _to_plain_json(v, _depth + 1, _max_depth) for k, v in obj.items()}

    # Lists and tuples
    if isinstance(obj, (list, tuple)):
        return [_to_plain_json(v, _depth + 1, _max_depth) for v in obj]

    # Objects with conversion methods
    for method_name in ("to_dict", "as_dict", "model_dump", "dict"):
        method = getattr(obj, method_name, None)
        if callable(method):
            try:
                result = method()
                if isinstance(result, dict):
                    return _to_plain_json(result, _depth + 1, _max_depth)
            except Exception:
                pass

    # Try vars()
    try:
        obj_vars = vars(obj)
        if isinstance(obj_vars, dict) and obj_vars:
            return _to_plain_json(obj_vars, _depth + 1, _max_depth)
    except Exception:
        pass

    return str(obj)


# ============================================================================
# VISUALIZATION
# ============================================================================

def _draw_label_band(
    img: np.ndarray,
    x1: int,
    y1: int,
    text: str,
    color: Tuple[int, int, int],
    thickness: int,
    font_scale: float
) -> None:
    """
    Draw Ultralytics-style label band above bounding box.

    Args:
        img: Image array (modified in-place)
        x1: Top-left x coordinate
        y1: Top-left y coordinate
        text: Label text
        color: BGR color tuple
        thickness: Line thickness
        font_scale: Font scale
    """
    font = cv2.FONT_HERSHEY_SIMPLEX
    text_thickness = max(thickness // 2, 1)

    # Get text size
    (text_width, text_height), _ = cv2.getTextSize(text, font, font_scale, text_thickness)
    text_height = int(text_height * 1.2)

    # Calculate band coordinates
    y1_band = max(0, y1 - text_height - 3)
    x2_band = x1 + text_width + 6

    # Draw filled rectangle
    cv2.rectangle(img, (x1, y1_band), (x2_band, y1), color, -1)

    # Draw border
    cv2.rectangle(img, (x1, y1_band), (x2_band, y1), color, text_thickness)

    # Draw text
    cv2.putText(
        img, text, (x1 + 3, y1 - 5),
        font, font_scale, (0, 0, 0),
        thickness=text_thickness,
        lineType=cv2.LINE_AA
    )


def draw_parking_roi_overlays(frame: np.ndarray) -> np.ndarray:
    """
    Draw parking ROI zones on frame (entry, exit, slots).

    Args:
        frame: BGR image array

    Returns:
        Frame with ROI overlays
    """
    if _PARKING_ROI_DATA is None:
        return frame

    overlay = frame.copy()
    alpha = 0.3  # Transparency

    # Draw Entry ROI (Green)
    if 'entry_roi' in _PARKING_ROI_DATA:
        entry_points = np.array(_PARKING_ROI_DATA['entry_roi'], dtype=np.int32)
        cv2.polylines(overlay, [entry_points], isClosed=True, color=(0, 255, 0), thickness=2)
        cv2.fillPoly(overlay, [entry_points], color=(0, 255, 0))

        if len(entry_points) > 0:
            x, y = entry_points[0]
            cv2.putText(overlay, "ENTRY", (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

    # Draw Exit ROI (Red)
    if 'exit_roi' in _PARKING_ROI_DATA:
        exit_points = np.array(_PARKING_ROI_DATA['exit_roi'], dtype=np.int32)
        cv2.polylines(overlay, [exit_points], isClosed=True, color=(0, 0, 255), thickness=2)
        cv2.fillPoly(overlay, [exit_points], color=(0, 0, 255))

        if len(exit_points) > 0:
            x, y = exit_points[0]
            cv2.putText(overlay, "EXIT", (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

    # Draw Parking Slot ROIs (Blue)
    if 'slot_rois' in _PARKING_ROI_DATA:
        for slot_name, slot_points in _PARKING_ROI_DATA['slot_rois'].items():
            slot_pts = np.array(slot_points, dtype=np.int32)
            cv2.polylines(overlay, [slot_pts], isClosed=True, color=(255, 0, 0), thickness=2)
            cv2.fillPoly(overlay, [slot_pts], color=(255, 0, 0))

            if len(slot_pts) > 0:
                x, y = slot_pts[0]
                cv2.putText(overlay, slot_name, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)

    # Blend overlay with original frame
    return cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0)


def draw_overlays_bgr(
    frame_bgr: np.ndarray,
    meta,
    *,
    debug_tick: bool = False,
    draw_parking_roi: bool = False
) -> Tuple[np.ndarray, int, List[Dict[str, Any]]]:
    """
    Draw detection overlays on BGR frame with Ultralytics-style visualization.

    Args:
        frame_bgr: BGR image array
        meta: AxMeta object from Voyager SDK
        debug_tick: Whether to draw debug indicator
        draw_parking_roi: Whether to draw parking ROI zones

    Returns:
        Tuple of (annotated_frame, num_detections, detections_list)
    """
    h, w = frame_bgr.shape[:2]

    # Calculate adaptive thickness and font scale
    thickness = max(1, int(round(0.003 * (h + w) / 2)))
    font_scale = max(0.5, 0.5 + 0.0008 * (h + w)) / 2.0

    # Draw parking ROI if enabled
    if draw_parking_roi:
        frame_bgr = draw_parking_roi_overlays(frame_bgr)

    id_to_name = extract_class_map_from_meta(meta)
    if not id_to_name:
        id_to_name = get_class_map()

    detections_list = []
    num_drawn = 0

    # Iterate over detections
    for kind_box, label_id, score in _iter_detections(meta) or []:
        xyxy = _normalize_xyxy(kind_box, w, h)
        if not xyxy:
            continue

        x1, y1, x2, y2 = xyxy

        # Clamp to frame boundaries
        x1 = max(0, min(x1, w - 1))
        y1 = max(0, min(y1, h - 1))
        x2 = max(0, min(x2, w - 1))
        y2 = max(0, min(y2, h - 1))

        # Skip invalid boxes
        if x2 <= x1 or y2 <= y1:
            continue

        # Get color and label
        color = _color_for_class(label_id)
        label_name = id_to_name.get(label_id) if label_id is not None else None

        # Draw bounding box
        cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), color, thickness)

        # Build label text
        label_parts = []
        if label_name:
            label_parts.append(label_name)
        elif label_id is not None:
            label_parts.append(str(label_id))

        # Draw label band
        if label_parts:
            label_text = " ".join(label_parts)
            _draw_label_band(frame_bgr, x1, y1, label_text, color, thickness, font_scale)

        # Record detection
        detections_list.append({
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "label_id": label_id,
            "label_name": label_name,
            "score": float(score) if score is not None else None,
        })

        num_drawn += 1

    # Draw debug tick
    if debug_tick:
        cv2.circle(frame_bgr, (10, 10), 4, (0, 255, 255), -1)

    return frame_bgr, num_drawn, detections_list


def to_bgr24(image) -> np.ndarray:
    """
    Convert various image formats to BGR24 numpy array.

    Args:
        image: Input image (numpy array or Voyager AxImage)

    Returns:
        BGR24 numpy array

    Raises:
        TypeError: If image type is unsupported
        ValueError: If image has unsupported channel layout
    """
    # Handle numpy arrays directly
    if isinstance(image, np.ndarray):
        arr = image
    else:
        arr = None

        # Try asarray() method
        asarray_fn = getattr(image, "asarray", None)
        if callable(asarray_fn):
            try:
                arr = asarray_fn()
            except Exception:
                pass

        # Try manual reconstruction from buffer
        if arr is None:
            width = getattr(image, "width", None)
            height = getattr(image, "height", None)
            pixel_stride = getattr(image, "pixel_stride", None)
            pitch = getattr(image, "pitch", None)

            # Get buffer
            buf = None
            tobytes_fn = getattr(image, "tobytes", None)
            if callable(tobytes_fn):
                try:
                    buf = tobytes_fn()
                except Exception:
                    pass

            if buf is None:
                buf = getattr(image, "data", None)

            # Reconstruct array
            if all([width, height, pixel_stride, pitch]) and buf is not None:
                flat = np.frombuffer(buf, dtype=np.uint8)
                row_view = flat.reshape(int(height), int(pitch))
                active = row_view[:, : int(width) * int(pixel_stride)]
                arr = active.reshape(int(height), int(width), int(pixel_stride))

        if arr is None:
            raise TypeError(f"Unsupported image type: {type(image).__name__}")

    # Ensure uint8 dtype
    if arr.dtype != np.uint8:
        arr = arr.astype(np.uint8, copy=False)

    # Handle channel layout
    if arr.ndim == 2:
        # Grayscale -> BGR
        arr = np.stack([arr, arr, arr], axis=-1)
    elif arr.ndim == 3:
        num_channels = arr.shape[2]

        if num_channels == 4:
            # BGRA/RGBA -> BGR
            arr = arr[:, :, :3]
        elif num_channels == 1:
            # Single channel -> BGR
            arr = np.repeat(arr, 3, axis=2)
        elif num_channels != 3:
            raise ValueError(f"Unsupported channel count: {num_channels} (shape={arr.shape})")
    else:
        raise ValueError(f"Unexpected array dimensions: {arr.ndim}")

    # Ensure contiguous BGR array (flip RGB if needed)
    return np.ascontiguousarray(arr[:, :, ::-1])


# ============================================================================
# SDK INITIALIZATION
# ============================================================================

if not os.environ.get("AXELERA_FRAMEWORK"):
    sys.exit("[ERROR] Please activate the Axelera environment")

from axelera.app import config, display, inf_tracers, logging_utils
from axelera.app.stream import create_inference_stream

LOG = logging_utils.getLogger(__name__)


def init(args, tracers):
    """
    Initialize inference stream from Voyager SDK.

    Args:
        args: Parsed command-line arguments
        tracers: Inference tracers

    Returns:
        Inference stream object
    """
    return create_inference_stream(
        config.SystemConfig.from_parsed_args(args),
        config.InferenceStreamConfig.from_parsed_args(args),
        config.PipelineConfig.from_parsed_args(args),
        config.LoggingConfig.from_parsed_args(args),
        config.DeployConfig.from_parsed_args(args),
        tracers=tracers,
    )