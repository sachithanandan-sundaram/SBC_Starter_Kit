FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN curl https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py && \
    python /tmp/get-pip.py --force-reinstall && \
    pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p \
    /app/data/models \
    /app/data/recordings \
    /app/data/events \
    /app/data/hls \
    /app/data/uploads

# GID 44 = standard Linux video group — matches host /dev/video* ownership
RUN groupadd -g 44 video || true && \
    useradd -m -u 1000 -G video appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]