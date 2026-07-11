# Unified Dashboard - Vision AI Dashboard

A full-stack vision AI dashboard application for AI vision inference, video streaming, and monitoring. Built with FastAPI backend and modern React/TypeScript frontend.

## 🎯 Features

- **Live Video Streaming**: RTSP, USB camera, and video file input support
- **HLS Streaming**: Real-time HTTP Live Streaming (HLS) protocol support
- **AI Inference**: Mock and real inference engine support
- **Multi-stream Grid**: 2x2 grid view for simultaneous video streams
- **Recording Management**: Record and playback video streams
- **Event Tracking**: Monitor and log AI detection events
- **Model Management**: Manage and switch between inference models

## 📋 Project Structure

```
.
├── backend/              # FastAPI backend server
│   ├── app/
│   │   ├── main.py      # Application entry point
│   │   ├── config.py    # Configuration management
│   │   ├── state.py     # AppState singleton for thread-safe state
│   │   ├── frame_broadcaster.py  # Single-source frame broadcaster to 4 slots
│   │   ├── mjpeg_utils.py        # MJPEG encoding and annotation
│   │   ├── inference/
│   │   │   ├── yolo11_engine.py  # YOLO11 auto-download and inference
│   │   │   └── mock_engine.py    # Mock inference (legacy)
│   │   ├── routers/
│   │   │   ├── health.py         # Health check
│   │   │   ├── stream_new.py     # MJPEG streaming (RTSP, USB, Video File)
│   │   │   ├── models_new.py     # Slot-based model management (1-4)
│   │   │   ├── recordings_new.py # Server-side recording with background thread
│   │   │   ├── playback_new.py   # Video serving with HTTP range requests
│   │   │   └── [old files]       # Legacy routers (not used)
│   │   ├── schemas/
│   │   ├── services/
│   │   └── dependencies.py
│   ├── data/
│   │   ├── events/      # Event logs
│   │   ├── hls/         # Legacy HLS segments (not used)
│   │   ├── models/      # Downloaded YOLO models (yolo11n.pt auto-downloads here)
│   │   ├── recordings/  # Default recording output directory
│   │   └── videos/      # ⭐ Place your .mp4 video files here for LiveView "Video File" source
│   ├── tests/
│   ├── requirements.txt  # Python dependencies (FastAPI, OpenCV, Ultralytics)
│   └── Dockerfile
├── frontend/            # React + TypeScript + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── live/                 # Live view components
│   │   │   │   ├── MJPEGPlayer.tsx   # MJPEG img-tag player
│   │   │   │   ├── GridCell.tsx      # Single stream cell in 2×2 grid
│   │   │   │   ├── GridVideoPlayer.tsx
│   │   │   │   ├── RtspInput.tsx     # RTSP URL input
│   │   │   │   ├── UsbSelector.tsx   # USB camera selector
│   │   │   │   └── VideoFileInput.tsx # Video file path input (full file path)
│   │   │   ├── playback/             # Playback components
│   │   │   ├── ui/                   # shadcn/ui components
│   │   │   └── ...
│   │   ├── pages/
│   │   │   ├── LiveViewPage.tsx      # Live 2×2 grid with source selector
│   │   │   ├── RecordingPage.tsx     # Server-side recording control
│   │   │   ├── PlaybackPage.tsx      # Recorded video playback
│   │   │   ├── ModelsPage.tsx        # Model management (1-4 slots)
│   │   │   └── ...
│   │   ├── hooks/
│   │   │   ├── useUsbDevices.ts      # Calls /api/cameras backend
│   │   │   └── ...
│   │   ├── main.tsx
│   │   └── ...
│   ├── vite.config.ts  # Proxy config: /api → http://localhost:8000
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

### Key Architecture Details

**Backend**:
- **AppState singleton** (`app/state.py`): Thread-safe centralized state for source, models, recordings
- **FrameBroadcaster** (`app/frame_broadcaster.py`): Single background thread reads from source (RTSP/USB/File), broadcasts frames to 4 independent deques (avoids multiple OpenCV instances on same source)
- **YOLO11 inference** (`app/inference/yolo11_engine.py`): Auto-downloads model on first use, singleton pattern
- **MJPEG streaming** (`app/routers/stream_new.py`): Low-latency streaming with optional YOLO11 annotation overlay
- **Server-side recording** (`app/routers/recordings_new.py`): Background thread writes frames from broadcaster to .mp4 using OpenCV VideoWriter
- **Range request support** (`app/routers/playback_new.py`): HTML5 video seeking works via HTTP 206 Partial Content

**Frontend**:
- **React state management**: Component-level state with localStorage for persistence (tours, preferences)
- **Vite proxy**: `/api/*` requests proxied to `http://localhost:8000` in dev mode
- **MJPEG playback**: Simple `<img>` tag with `src` pointing to streaming endpoint
- **Polling model count**: Pages poll `/api/models/list` every 2 seconds to update UI when models change



## 🚀 Quick Start

### Prerequisites

- **Backend**: Python 3.11+, pip
- **Frontend**: Node.js 18+, npm or bun
- **Docker** (optional): Docker and Docker Compose for containerized deployment

### Local Development

#### Backend Setup

```bash
# Navigate to backend directory
cd backend

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the server (no setup needed - directories auto-created)
python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend will be available at `http://localhost:8000`

API documentation (Swagger UI) at `http://localhost:8000/docs`

**Note**: 
- YOLO11 model downloads automatically on first inference (~5MB, takes 2-3 seconds)
- Recording save paths are user-selected at runtime
- No need to create any directories beforehand

#### Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install  # or bun install

# Configure environment
cp .env.example .env.development  # If needed

# Start development server
npm run dev  # or bun dev
```

Frontend will be available at `http://localhost:5173`

### Docker Deployment

```bash
# From the root directory
docker-compose up -d

# Access the application
# Frontend: http://localhost:3000
# Backend API: http://localhost:8000
# API Documentation: http://localhost:8000/docs
```

## 📦 Dependencies

### Backend

Main dependencies (see `backend/requirements.txt` for complete list):
- **FastAPI**: Modern Python web framework
- **Uvicorn**: ASGI server
- **Pydantic**: Data validation
- **aiofiles**: Async file I/O
- **httpx**: Async HTTP client

### Frontend

Main dependencies (see `frontend/package.json` for complete list):
- **React**: UI library
- **TypeScript**: Type safety
- **Vite**: Build tool
- **Tailwind CSS**: Utility-first CSS framework
- **shadcn/ui**: Component library

## ⚙️ Configuration

### Backend Environment Variables

See `backend/.env.example`:

```env
APP_ENV=development              # Environment mode
APP_HOST=0.0.0.0               # Server host
APP_PORT=8000                  # Server port
INFERENCE_MODE=mock            # mock | real
CORS_ORIGINS=http://localhost:5173  # CORS allowed origins
```

### Frontend Environment Variables

Configure as needed in `frontend/.env.development` for development or `frontend/.env.production` for production.

## 🧪 Testing

### Backend Tests

```bash
cd backend
pip install -r requirements-dev.txt  # Install dev dependencies
pytest                               # Run tests
pytest tests/test_health.py         # Run specific test
```

### Frontend Tests

```bash
cd frontend
npm run test              # Run tests with Vitest
npm run test:ui          # UI mode
npm run test:coverage    # Coverage report
```

## 🔨 Build & Deployment

### Backend Build

The backend runs directly from source in development. For production, Docker is recommended.

### Frontend Build

```bash
cd frontend
npm run build          # Build for production
npm run preview        # Preview production build
```

Built files are in `frontend/dist/`

## 📝 API Endpoints

### Stream Endpoints

- `POST /api/stream/start` - Start MJPEG stream from source (RTSP, USB, or Video File)
- `DELETE /api/stream/stop` - Stop the current stream
- `GET /api/stream/raw/{slot}` - MJPEG stream without inference
- `GET /api/stream/annotated/{slot}` - MJPEG stream with YOLO11 annotations
- `GET /api/cameras` - List USB cameras

### Model Endpoints

- `GET /api/models/list` - List loaded models (max 4 slots)
- `POST /api/models/add` - Add a model (slot-based, auto-compact on removal)
- `DELETE /api/models/{slot}` - Remove model from slot

### Recording Endpoints

- `GET /api/recordings/pick-folder` - Native folder picker (returns path)
- `POST /api/recordings/start` - Start recording from slot
- `POST /api/recordings/pause` - Pause active recording
- `POST /api/recordings/resume` - Resume paused recording
- `POST /api/recordings/stop` - Stop and save recording

### Playback Endpoints

- `GET /api/playback/list` - List available recordings
- `GET /api/playback/video/{filename}` - Stream video with range request support

### Health

- `GET /api/health` - Health check

See `http://localhost:8000/docs` for full interactive API documentation (Swagger UI).

## 🐛 Troubleshooting

### Backend Connection Issues (ECONNREFUSED)

**Problem**: Frontend shows "Connection refused" or `ECONNREFUSED` errors

**Causes**:
- Backend is not running
- Backend is running on wrong port (default: 8000)
- Firewall blocking localhost:8000

**Solutions**:
```bash
# 1. Verify backend is running
cd backend && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 2. Check if port is in use
# Windows: netstat -ano | findstr :8000
# Mac/Linux: lsof -i :8000

# 3. Access API docs to verify backend is working
curl http://localhost:8000/docs
```

### Video File Won't Play or "Invalid Path" Error

**Problem**: LiveView page won't play video file or shows path validation error

**Solution**: Enter the full file path to your video file:

**Windows examples**:
```
C:\Users\YourName\Videos\sample.mp4
C:\Videos\test.mp4
D:\Movies\video.mp4
```

**Mac/Linux examples**:
```
/Users/YourName/Videos/sample.mp4
/home/username/videos/test.mp4
/var/videos/sample.mp4
```

**Steps to test**:
1. Get full path to an `.mp4` file on your system
2. In LiveView page "Video File" tab, paste the path in the text input
3. Click "Select Video"
4. Click "Start Stream"

**Supported formats**: `.mp4` (H.264 codec recommended)

**Troubleshooting**:
- ✅ Verify the file path is correct (copy exact path from file manager)
- ✅ Ensure file has `.mp4` extension
- ✅ File must be readable by your user
- ✅ File paths with spaces may need quotes on some systems

### Source Selector Doesn't Hide After Starting Stream

**Problem**: The source configuration section stays visible even after clicking "Start Stream"

**Causes**:
1. Backend `/api/stream/start` call is failing (check browser console and backend logs)
2. Frontend state isn't updating due to connection error

**Solutions**:
1. **Check backend logs** for errors when calling `/api/stream/start`
2. **Verify endpoint is working**:
   ```bash
   curl -X POST http://localhost:8000/api/stream/start \
     -H "Content-Type: application/json" \
     -d '{"source_type":"USB", "source_value":"0"}'
   ```
3. **For RTSP**: Ensure the URL is valid and the stream is accessible
4. **For USB**: Ensure camera is connected and accessible. Windows sometimes blocks device access—try disconnecting/reconnecting the camera
5. **For Video File**: Ensure file is in `backend/data/videos/` directory

### Stream State Lost on Page Refresh ✅ FIXED

**Problem**: When you refresh the page (F5), the stream stops and the UI returns to "not streaming" state

**Root Cause**: React state is stored in memory. When the page reloads, all state is cleared.

**Current Behavior**: ✅ **FIXED** - Stream state now persists to browser localStorage. On page refresh:
- Video source (RTSP URL, USB camera, or video file path) is restored
- Models that were loaded remain in the model slots
- You can navigate between pages (LiveView ↔ Models ↔ Recording ↔ Playback) without losing state
- State persists across browser refreshes

**How It Works**:
- Frontend stores stream state and source info in localStorage whenever they change
- On page reload, the StreamContext automatically restores from localStorage
- The ApplicationStack works seamlessly regardless of navigation order (add models first OR start stream first)

### Stream Unavailable (503 Service Unavailable)

**Problem**: Sometimes you see HTTP 503 errors on `/api/stream/annotated/{slot}`

**Causes**:
- Broadcaster disconnected (network issue, camera unplugged, RTSP feed dropped)
- No model configured for the slot
- Source became inaccessible

**Solutions**:
1. **Check connection**: Verify your RTSP URL is still accessible or USB camera is still plugged in
2. **Restart stream**: Stop the stream and start it again
3. **Check errors**: Look at browser console and backend logs for more details
4. **Verify model is loaded**: If using "Annotated View", ensure you have at least one model added to the model slots

**Recovery**:
- Stream state monitors connectivity every 10 seconds
- If disconnected, the frontend will clear the streaming state automatically
- You'll see a red "Stream Unavailable" message with "Retrying connection..." status
- Once the source is accessible again, you can restart the stream

### Adding Models and Starting Streams (Any Order)

**New Feature**: The application now handles both workflow orders seamlessly:

**Use Case 1: Load Models First**
1. Go to **Models Page** → add some models to slots
2. Go to **Live View Page** → start a stream
3. Models are remembered and stay loaded
4. Refresh the page—everything persists ✅

**Use Case 2: Start Stream First**
1. Go to **Live View Page** → start streaming with RTSP/USB/Video File
2. Go to **Models Page** → add models
3. Go back to **Live View** → models are still there and annotation is active
4. Refresh the page—both stream and models persist ✅

**How It Works**:
- StreamContext in localStorage stores: source type, source value, model count, annotation toggle
- ModelsPage polls the backend every 2 seconds for model list
- Both pages can be visited in any order without state conflicts
- Cross-page synchronization happens automatically

### Video Streaming Issues (MJPEG)

**Problem**: MJPEG streams (raw or annotated) won't play or show frame drops

**Solutions**:
- **Slow FPS**: YOLO11 inference adds ~100ms latency per frame. Disable "Annotated View" toggle for faster raw stream
- **No frames appearing**: Check that source is actually connected (check backend logs for "Capture opened" message)
- **USB camera not detected**: Windows USB camera enumeration can be slow. Backend tries indices 0-9. If your camera is at a higher index, manually enter it via browser console

### YOLO11 Model Download Issues

**Problem**: First inference call is very slow or fails

**Root Cause**: First time using YOLO11, it downloads the model (~5MB) from Ultralytics GitHub

**Solutions**:
```bash
# Pre-download the model before running backend
cd backend
python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"
```

This caches the model so first inference is fast.

### Recording Issues

**Problem**: Recording returns an error or file not found

**Solutions**:
1. **Pick folder first**: Click "Choose Folder" and select where recordings should be saved
2. **Ensure write permissions**: Make sure you have write access to the selected folder
3. **Check recordings saved**: Recorded .mp4 files are saved to your selected location (usually in Recordings or a custom folder you picked)

### Playback Video Won't Play

**Problem**: Playback page shows recording but HTML5 video player shows blank screen

**Solutions**:
1. **Ensure backend is running**: Playback uses HTTP range requests—backend must serve the file
2. **Check file exists**: Verify the .mp4 file actually exists in the save location
3. **Browser compatibility**: Use Chrome, Firefox, or Safari. IE doesn't support range requests

### High CPU Usage

**Problem**: CPU spikes when using YOLO11 inference ("Annotated View")

**Root Cause**: YOLO11 inference runs on every frame. Each inference can take 50-200ms on CPU.

**Solutions**:
1. **Disable annotation for multiple streams**: Annotate only 1 slot if running 2×2 grid
2. **Lower FPS**: Frame broadcaster targets 30 FPS; you can reduce in backend code
3. **Use GPU** (future enhancement): Install CUDA and update yolo11_engine.py to use GPU

### OpenCV Camera Index Out of Range

**Problem**: Backend logs show `[ERROR:0@...] Camera index out of range`

**Root Cause**: Backend tries USB camera indices 0-9 during enumeration. Some cameras are at higher indices or require special drivers.

**Solutions**:
1. **Ignore these errors** if at least one camera appears in "/api/cameras" list
2. **Install camera drivers** (Windows: might need DirectShow drivers)
3. **Try another USB port** if camera is repeatedly failing
4. **Use RTSP fallback**: If USB doesn't work, get an RTSP stream URL for your camera

### Source Switch Causes Brief Disconnect

**Problem**: Switching between RTSP/USB/Video File sources temporarily stops the stream

**Expected Behavior**: Calling `/api/stream/start` with a new source automatically stops the old one and starts the new one. This is intentional to ensure only one source streams at a time (per specification).

If this is undesired, modify LiveViewPage.tsx to NOT call handleStopStream() when switching sources.

## 💡 Performance Tips

- **Disable annotation toggle** when not needed (raw MJPEG is ~5x faster than annotated)
- **Use USB cameras** instead of RTSP if possible (lower latency)
- **For remote RTSP streams**: Ensure bandwidth is sufficient (typically 2-5 Mbps for 640×480 @ 30fps)
- **Record without annotation**: Recording uses raw frames, not annotated ones, so it's fast

## 📦 Known Limitations

- **Browser file restrictions**: HTML file pickers can't access arbitrary filesystem paths. Use `backend/data/videos/` directory.
- **Single stream**: Only supports one active source at a time (per spec)
- **YOLO11 CPU-only**: Inference runs on CPU; GPU support requires CUDA setup
- **No authentication**: API is not secured; use firewall rules in production
- **Windows USB camera drivers**: Some USB cameras require specific Windows drivers (UVC, DirectShow)

## 📄 License

[Add your license here]

## 👥 Contributing

Contributions are welcome! Please follow the existing code style and add tests for new features.

## 📞 Support

For issues or questions, please create an issue in the repository.

---

**Last Updated**: March 2026
