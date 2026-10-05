# media-gateway

HTTP media gateway for Google Drive. Give it a Drive file ID (or share URL) and serve the file as a normal media URL for `<img>`, `<video>`, and `<audio>`, including HTTP Range so browsers can seek large videos.

## Architecture

```text
Browser
   ↓  HTTP + Range
media-gateway
   ↓  stream
Google Drive
```

Files are streamed. The gateway does not buffer entire objects in memory.

## Installation

```bash
cp .env.example .env
npm install
```

## Configuration

See `.env.example`. Public/shared Drive files work without credentials. Optional `GOOGLE_*` variables improve metadata access and private files.

## Start

```bash
npm start
```

## Homepage

Open `/` for a small UI that turns a Drive link/ID into a direct `/media/{id}` URL for the current host.

## API

```text
GET  /
GET  /media/:id
HEAD /media/:id
GET  /api/resolve?input=
GET  /api/validate?input=
GET  /health
GET  /ready
GET  /metrics
```

```bash
curl -I http://localhost:5012/media/DRIVE_FILE_ID
curl -H 'Range: bytes=0-1048575' -D- -o chunk.bin \
  http://localhost:5012/media/DRIVE_FILE_ID
```

```html
<img src="http://localhost:5012/media/DRIVE_FILE_ID" alt="">
<video src="http://localhost:5012/media/DRIVE_FILE_ID" controls></video>
<audio src="http://localhost:5012/media/DRIVE_FILE_ID" controls></audio>
```

## Supported media

Anything Google Drive can download with a usable MIME type — typically images, video, and audio that browsers play natively (`image/*`, `video/mp4`, `video/webm`, `audio/mpeg`, etc.).

## Recommended file-size limits

There is **no hardcoded file-size limit** in media-gateway. Size is constrained by Google Drive, your VPS bandwidth, concurrent stream caps, and upstream idle timeouts between chunks — not by loading the whole file into RAM.

Operational recommendations (not protocol limits):

| Type   | Recommended        | Notes |
|--------|--------------------|--------|
| Images | up to **25 MiB**   | Fine for web embeds; larger still streams but is rarely useful in browsers |
| Audio  | up to **200 MiB**  | Full tracks stream well with Range |
| Video  | up to **5 GiB**   | Seeking works via `206` Range responses |

**Technical maximum:** unbounded in application code. In practice, multi‑GB video works when Drive remains reachable and the client keeps reading (idle timeout resets per chunk). Very large or heavily rate-limited Drive files may fail with upstream `502`/`504` before the gateway hits any local size cap.

## Production

Run on a VPS behind a reverse proxy. Forward `Range` headers, disable response buffering for `/media`, and use long proxy read timeouts. Set `TRUST_PROXY=true` when behind a proxy.

```bash
docker build -t media-gateway .
docker run --rm -p 5012:5012 --env-file .env media-gateway
```
