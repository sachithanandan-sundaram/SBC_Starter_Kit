# Issue Resolution Summary

## Problems Reported

| Issue | Cause | Status |
|-------|-------|--------|
| ECONNREFUSED & 404 errors | Backend stopped while frontend was polling | ✅ Documented |
| Video file "can't be found" | Browser security restriction + missing directory | ✅ Fixed |
| Source selector doesn't hide | Connection failures prevent state update | ✅ Diagnosed |
| State lost on page refresh | React state is in-memory, not persistent | ✅ Documented as expected behavior |

---

## What Was Done

### 1. ✅ Created `backend/data/videos/` Directory
- Located at: `backend/data/videos/`
- Purpose: Store test .mp4 video files for LiveView "Video File" source
- Includes README with usage instructions

### 2. ✅ Updated README.md with Comprehensive Troubleshooting
Added new sections covering:
- **Backend Connection Issues**: Why ECONNREFUSED happens and how to fix
- **Video File "Can't Be Found"**: Why browser file pickers are restricted + workaround
- **Source Selector Doesn't Hide**: Connection troubleshooting steps
- **Stream State Lost on Refresh**: Explanation + workaround (localStorage for future)
- **YOLO11 Download Issues**: Pre-download instructions
- **Recording Issues**: Setup and permissions troubleshooting
- **Playback Issues**: Range request support explanation
- **High CPU Usage**: Annotation performance tips
- **OpenCV Warnings**: Camera enumeration explanation
- **Performance Tips**: Best practices
- **Known Limitations**: Clear list of browser/security restrictions

### 3. ✅ Updated Project Structure Documentation
- Added detailed breakdown of all new backend files (state.py, frame_broadcaster.py, etc.)
- Explained architecture: AppState singleton, FrameBroadcaster pattern, MJPEG streaming
- Highlighted key features and design decisions

### 4. ✅ Created QUICKSTART.md
- 5-minute setup guide
- Step-by-step testing procedures (6 test scenarios)
- Common issues with solutions
- Useful curl commands for API testing

### 5. ✅ Updated Backend Setup Instructions
- Added directory creation steps
- Explained YOLO11 auto-download
- Clarified port and API docs location

---

## How to Fix Each Issue

### Issue #1: Connection Errors (ECONNREFUSED)

**Action**:
```bash
# Terminal 1: Start backend
cd backend
venv\Scripts\activate
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2: Start frontend
cd frontend
npm run dev
```

**Verify**:
- Backend: `http://localhost:8000/docs` should show API docs
- Frontend: `http://localhost:8081/` should load app
- Check browser console for errors (should show successful `/api/models/list` calls)

---

### Issue #2: Video File "Can't Be Found"

**Action**:
```bash
# 1. Ensure directory exists
mkdir -p backend\data\videos

# 2. Copy your .mp4 file
copy "C:\Users\<your_user>\Videos\sample.mp4" backend\data\videos\

# 3. In app, LiveView → "Video File" tab → choose file → Start Stream
```

**Why it works**:
- Frontend sends filename only (due to browser security)
- Backend adds full path: `backend/data/videos/ + filename`
- OpenCV can now find the file

---

### Issue #3: Source Selector Doesn't Hide

**Action**:
1. Ensure backend is running (check terminal for no errors)
2. Use USB camera (most reliable):
   - Plug in USB camera
   - Select "USB" tab
   - Click "Start Stream"
   - If it works: selector should hide and stream appears in grid
3. If still fails, check backend logs for error message

**Debug steps**:
```bash
# Test endpoint directly
curl -X POST http://localhost:8000/api/stream/start \
  -H "Content-Type: application/json" \
  -d "{\"source_type\": \"USB\", \"source_value\": \"0\"}"

# Should return something like:
# {"status": "streaming", "message": "USB source 0 connected"}
```

---

### Issue #4: State Lost on Page Refresh

**Expected Behavior**: ✅ This is by design

When you press F5 or reload the page:
- React clears all in-memory state
- Stream stops (OnViewPage reverts to "not streaming")
- To resume, just restart the stream (2 clicks)

**If you want persistence** (future enhancement):
- Use localStorage to save stream config
- Check on page load if stream should auto-recover
- This would be a nice-to-have feature

**For now**: Workaround is manual restart on page refresh

---

## Recommended Testing Sequence

1. ✅ **Backend connectivity**
   ```bash
   curl http://localhost:8000/docs
   # Should show Swagger UI
   ```

2. ✅ **Add a model** (to enable annotation)
   - LiveView → USB Tab → Start Stream
   - Models page → Add Default Model
   - Toggle "Annotated View" in Live View

3. ✅ **Test video file**
   - Copy `test.mp4` to `backend/data/videos/`
   - LiveView → Video File tab → choose file → Start

4. ✅ **Test recording**
   - Recording page → Choose Folder → select slot → click Start → Stop after 10s
   - Playback page → should list the recording
   - Click to play

---

## Quick Reference: API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/stream/start` | POST | Start MJPEG stream |
| `/api/stream/stop` | DELETE | Stop stream |
| `/api/stream/raw/{slot}` | GET | MJPEG without inference |
| `/api/stream/annotated/{slot}` | GET | MJPEG with YOLO11 |
| `/api/cameras` | GET | List USB cameras |
| `/api/models/list` | GET | List models (slots 1-4) |
| `/api/models/add` | POST | Add model |
| `/api/recordings/pick-folder` | GET | Folder picker |
| `/api/recordings/start` | POST | Start recording |
| `/api/recordings/stop` | POST | Stop recording |
| `/api/playback/list` | GET | List recordings |
| `/api/playback/video/{filename}` | GET | Stream recording |

---

## Files Changed

```
📝 README.md
   - Added comprehensive troubleshooting section
   - Updated project structure with architecture details
   - Updated backend setup instructions
   - Updated API endpoints documentation

➕ QUICKSTART.md (NEW)
   - 5-minute setup guide
   - 6 test scenarios
   - Common issues
   - Useful commands

📁 backend/data/videos/ (NEW)
   - Directory for test .mp4 files
   - Includes README with usage instructions

📋 /memories/session/deployment-issues-solved.md (NEW)
   - Internal notes on all issues and solutions
   - Testing checklist
```

---

## Next Steps for User

1. **Immediate**: 
   - Place a test .mp4 file in `backend/data/videos/`
   - Restart both backend and frontend
   - Follow QUICKSTART.md testing sequence

2. **If issues persist**:
   - Check backend logs (/api/docs shows live logs at `http://localhost:8000/docs`)
   - Use curl commands to test endpoints directly
   - Run the curl commands from Quick Reference above

3. **For production**:
   - Use Docker: `docker-compose up`
   - Build frontend: `npm run build`
   - Environment configuration in backend/.env

---

**All documented and ready to go!** 🎉
