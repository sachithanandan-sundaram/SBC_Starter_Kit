# Recordings Directory Setup for Docker

## Overview

The backend now supports configurable recordings and playback directories. This is useful when running on Raspberry Pi or other devices where you want to store recordings on external storage (USB drive, external SSD, etc.).

## Default Behavior

By default, recordings are stored in `/app/data/recordings` inside the Docker container. This maps to your local `./backend/data/recordings` directory.

## Custom Recordings Directory

### 1. Using Environment Variable (Recommended)

Set the `RECORDINGS_DIR` environment variable when running the container:

#### Docker Run
```bash
docker run -e RECORDINGS_DIR=/custom/path backend-image
```

#### Docker Compose

In your `docker-compose.yml`, add the environment variable to the backend service:

```yaml
services:
  backend:
    build: ./backend
    environment:
      - RECORDINGS_DIR=/recordings  # Path inside container
    volumes:
      - /mnt/external-drive/recordings:/recordings  # Mount external drive or folder
```

### 2. Using .env File

Create or update a `.env` file in the `backend/` directory:

```env
RECORDINGS_DIR=/custom/recordings/path
```

## Docker Volume Mounting Examples

### Example 1: Store recordings on external USB drive

**On Raspberry Pi:**
```yaml
services:
  backend:
    build: ./backend
    environment:
      - RECORDINGS_DIR=/mnt/recordings
    volumes:
      - /mnt/usb-drive/recordings:/mnt/recordings
```

### Example 2: Store recordings on shared network folder

```yaml
services:
  backend:
    build: ./backend
    environment:
      - RECORDINGS_DIR=/recordings
    volumes:
      - /mnt/nfs-share:/recordings
```

### Example 3: Large local directory

```yaml
services:
  backend:
    build: ./backend
    environment:
      - RECORDINGS_DIR=/large-storage/recordings
    volumes:
      - /large-local-partition/recordings:/large-storage/recordings
```

## Frontend Configuration

The frontend will automatically use the custom path when:

1. **Recording**: Specify the custom path when starting a new recording
2. **Playback**: Select the custom path folder using the "Browse" button
3. **Persistence**: The selected path is saved in browser localStorage

### Setting Default Playback Path

Click the "Browse" button in the Playback page to select a recordings folder. It will remember your choice.

## File Paths in Docker

When deploying the application on Raspberry Pi with Docker:

1. **Host System Path**: `/mnt/usb-drive/videos` (physical path on the Pi)
2. **Container Path**: `/recordings` (path inside the container, set via volume mount)
3. **Environment Variable**: `RECORDINGS_DIR=/recordings` (path the Python app sees)

## Deployment on Raspberry Pi

### Step 1: Mount external storage
```bash
sudo mount /dev/sda1 /mnt/external
mkdir -p /mnt/external/recordings
```

### Step 2: Update docker-compose.yml
```yaml
services:
  backend:
    build: ./backend
    environment:
      - RECORDINGS_DIR=/mnt/recordings
    volumes:
      - /mnt/external/recordings:/mnt/recordings
```

### Step 3: Start application
```bash
sudo docker-compose up -d
```

## Checking Current Configuration

The backend automatically creates the recordings directory if it doesn't exist. You can verify the setup:

1. Check backend logs: `docker-compose logs backend`
2. Access playback page and use "Browse" to confirm the path
3. Verify files are saved: `ls -la /mnt/external/recordings`

## Troubleshooting

### "Permission denied" errors
- Ensure the directory has proper permissions: `sudo chmod -R 777 /mnt/external/recordings`

### Videos not appearing in playback
- Verify the `RECORDINGS_DIR` environment variable matches the volume mount
- Check that files are actually being saved: `ls -la <recordings_path>`
- Ensure the same `save_path` is used in both recording and playback

### Slow recording performance
- Check USB drive speed (at least USB 2.0 recommended, USB 3.0 preferred)
- Monitor disk usage: `df -h` and `du -sh <recordings_path>`

## Notes

- All paths are validated to prevent directory traversal attacks
- Empty `RECORDINGS_DIR` or `save_path` defaults to `/app/data/recordings`
- The application automatically creates directories if they don't exist
- File permissions should be managed by the host system volume mounts
