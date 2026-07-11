# Quick Start Guide

## Prerequisites
new

- Python 3.11+
- Node.js 18+ (npm or bun)
- USB camera, RTSP stream, or MP4 video file on your system

## First-Time Setup (2 minutes)

### 1. Backend Setup

```bash
cd backend

# Create virtual environment
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate    # Mac/Linux

# Install dependencies
pip install -r requirements.txt

# Run backend (no setup needed, directories auto-created)
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

✅ Backend running on: `http://localhost:8000`
✅ API docs available at: `http://localhost:8000/docs`

### 2. Frontend Setup

In a **new terminal**:

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

✅ Frontend running on: `http://localhost:8081` (or next available port)

## Testing the App

### Test 1: Add a Model (Easy)

1. Go to **Models** page
2. Click "Add Default Model" → YOLOv11 model loads (first time takes 3-5 seconds to download)
3. Model appears in 2×2 grid at slot 1

### Test 2: Live View with USB Camera (Recommended)

1. Plug in a USB camera (or use your laptop's built-in camera)
2. Go to **Live View** page
3. Select **"USB"** tab
4. Click **"Start Stream"** → Camera feed appears in grid

### Test 3: Live View with Video File

1. Get the full path to an `.mp4` file on your system:
   ```
   Windows: C:\Users\YourName\Videos\sample.mp4
   Mac/Linux: /Users/YourName/Videos/sample.mp4
   ```

2. Go to **Live View** page
3. Select **"Video File"** tab
4. Paste/Enter the full file path in the text box
5. Click **"Select Video"** → Video plays and loops automatically

### Test 4: Annotation Overlay

After stream is running with 1+ model:

1. Toggle **"Annotated View"** switch
2. MJPEG stream with YOLO11 bounding boxes appears
3. Toggle back to raw for ~5x faster performance

### Test 5: Recording

1. Start a stream (any source)
2. Go to **Recording** page
3. Click "Choose Folder" → Pick a save location
4. Select a slot from the dropdown
5. Click "**Start Recording**"
6. After 10 seconds, click "**Stop**"
7. Toast shows: `Recording Saved: LiveView1_2026-03-23_00-55-12.mp4`

### Test 6: Playback

1. Go to **Playback** page
2. Select a recording from the list (from Test 5)
3. HTML5 player appears with video and controls
4. Drag the seek bar to test HTTP range requests

## Common Issues

### Backend won't start: `Address already in use`

```bash
# Find process on port 8000
netstat -ano | findstr :8000

# Kill it (replace PID)
taskkill /PID <PID> /F

# Or use different port
python -m uvicorn app.main:app --port 8001
```

### Video file says "Invalid file path" or won't play

- ✅ Ensure the full path is correct and file exists
- ✅ Use forward slashes `/` or escaped backslashes `\\` (some systems require this)
- ✅ File must be `.mp4` format (H.264 codec recommended)
- ✅ Make sure the path doesn't have special characters or spaces (or wrap in quotes)

**Example paths**:
```
Windows: C:\Users\john\Videos\test.mp4
Mac: /Users/john/Videos/test.mp4
Linux: /home/john/videos/test.mp4
```

### USB camera won't detect

- ✅ Check camera is plugged in and drivers installed
- ✅ Try disconnecting and reconnecting
- ✅ Warning messages in backend logs are OK (camera enumeration tries indices 0-9)

### State lost after page refresh

- ✅ This is expected—restart stream after F5 refresh
- ✅ Recordings and playback are saved to disk, so they persist

### SLOW performance

- ✅ Disable "Annotated View" toggle (YOLO11 inference takes 100ms per frame)
- ✅ Use USB camera instead of RTSP for lower latency
- ✅ Only annotate 1 slot if using 2×2 grid

## Key Features

✅ **Live View**: RTSP, USB camera, or MP4 video file sources  
✅ **MJPEG Streaming**: Low-latency MJPEG playback  
✅ **YOLO11 Inference**: Auto-downloads on first use (~5MB model)  
✅ **Annotations**: Real-time bounding box overlay with toggleable view  
✅ **Server-side Recording**: Background thread writes frames to .mp4  
✅ **Playback**: HTML5 video player with seek bar (HTTP range requests)  
✅ **Model Management**: Slot-based (1-4 models, auto-compact on removal)  
✅ **State Centralization**: AppState singleton prevents race conditions  

## Architecture Highlights

- **Backend**: FastAPI + OpenCV + Ultralytics YOLO11
- **Frontend**: React + TypeScript + Vite + Tailwind + shadcn/ui
- **Streaming**: MJPEG (not HLS)—lower latency
- **Design**: User state in frontend (React), app state in backend (AppState singleton)

## Next Steps

- Add custom RTSP streams
- Add multiple USB cameras
- Test recording → playback workflow
- Explore model management (add/remove/switch)
- Check backend API docs at `http://localhost:8000/docs`

## Useful Commands

```bash
# View API documentation
# Browser: http://localhost:8000/docs

# Test stream start endpoint
curl -X POST http://localhost:8000/api/stream/start \
  -H "Content-Type: application/json" \
  -d "{\"source_type\": \"USB\", \"source_value\": \"0\"}"

# List models
curl http://localhost:8000/api/models/list

# List recordings
curl http://localhost:8000/api/playback/list

# List cameras
curl http://localhost:8000/api/cameras
```

---

**Questions?** Check the full troubleshooting guide in [README.md at Troubleshooting section](../README.md#-troubleshooting)
