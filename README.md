# VidFetch — Next.js + Fastify

Migration of the Java Spring Boot + React/Vite project (`runbothnew.zip`) to **Next.js 15 (App Router) + React 19 + TypeScript + Tailwind** and **Node + Fastify 5 + TypeScript + Zod**. The Java backend and Vite setup are gone; yt-dlp and FFmpeg are still used for media.

```
frontend/   Next.js app            → http://localhost:3000
backend/    Fastify API            → http://localhost:4000
```

## Run locally
Requirements: Node ≥ 20, plus **yt-dlp** and **ffmpeg** on `PATH` (or set `YTDLP_PATH` / `YTDLP_FFMPEG_LOCATION`). For YouTube, yt-dlp also benefits from Deno (the Dockerfile installs it).

```bash
npm install                      # root helper (concurrently)
npm run install:all              # installs backend + frontend
cp backend/.env.example  backend/.env     # then export the variables (Node does not load .env by itself)
cp frontend/.env.example frontend/.env.local
npm run dev                      # both apps
# or separately:
npm run dev --prefix backend     # :4000
npm run dev --prefix frontend    # :3000
```
Verify: `curl localhost:4000/api/health`. Production: `npm run build && npm start`. Docker (backend): `docker build -t vidfetch-api backend`.

**Frontend ↔ backend contract:** the browser calls `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) directly, so the backend's `CORS_ORIGINS` must contain the frontend origin (default `http://localhost:3000`). Change both together when deploying.

## API (unchanged contracts; errors are always `{ "success": false, "message": "…" }`)
| Method & path | Notes |
|---|---|
| `GET /api/health` | *New.* `{success:true,status:"ok"}` |
| `POST` or `GET /api/media/info?url=…` | `url` also accepted in a JSON body. Returns `{success, platform, title, thumbnail, freeMaxQuality, audioSize, mp3Size, formats:[{quality:"720p", value:720, locked, size}]}`. Formats come from yt-dlp's real metadata (≥144p). 400 invalid link · 502 yt-dlp failure · 504 timeout · 503 busy |
| `GET /api/media/download?url=…&quality=720p` | Streams an MP4. `quality`: `best`, `4k`, `NNNp`/`NNN` (100–4320). Add `&audio=mp3` or `m4a` for audio. `token` (query) or `X-Premium-Token` header unlocks qualities above `FREE_MAX_QUALITY` (else 402). Response has `Content-Disposition: attachment; filename="download.<ext>"` (server-generated name only). Closing the connection cancels yt-dlp. |
| `POST /api/premium/order` | Creates a Razorpay order for the **server-configured** price (default ₹19 = 1900 paise). 503 if keys are placeholders. |
| `POST /api/premium/verify` | Body `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`. Verifies HMAC-SHA256(`order|payment`, key secret); returns `{success, token, expiresAt}`. |
| `GET /api/premium/status` | Header `X-Premium-Token` → `{success, active, expiresAt}` |

Rate limits (per IP/minute, same buckets as before): info 30, download 5, order+verify 10 → 429 + `Retry-After: 60`.

## Feature inventory (original → migrated)
| Original feature | Status |
|---|---|
| Info endpoint, platform detection, URL allow-list (https YouTube watch/shorts/youtu.be, Instagram reel/reels/p/tv/stories) | ✅ same regex, same 300-char cap |
| Quality list from yt-dlp metadata, size estimates, audio size, MP3 size estimate, carousel → first item | ✅ ported (`ytdlp.service.ts`) |
| Video download (`bv*+ba/b`, `-S res:N,vcodec:h264,acodec:aac`, merge to MP4), MP3/M4A extraction | ✅ same yt-dlp arguments, built server-side only |
| 3 concurrent downloads (5 s wait → 503), info queue of 20, in-flight de-dup, 10-min/500-entry cache | ✅ |
| Timeouts 40 s info / 300 s download / 60 s info wait; `--max-filesize`; process-tree kill | ✅ |
| Friendly yt-dlp error messages | ✅ same texts |
| Rate limiting (fixed window per IP, 3 buckets), CORS allow-list, trust-proxy flag | ✅ |
| Premium: order, signature verify, signed token (same token format), status, 30-day entitlement, ₹19 | ✅ |
| Frontend: Instagram landing, YouTube page, auto-analysis on paste, live preview (YouTube thumbnail+oEmbed, Instagram embed), quality & audio buttons with sizes, blob download, reviews form (Web3Forms), AdSense slot, ad-block wall, responsive CSS | ✅ ported (hash route `#/youtube` → `/youtube`, old links redirect) |
| Dockerfile (yt-dlp + ffmpeg + Deno) | ✅ rewritten for Node |
| **Premium UI** | ➖ **never existed** in the original frontend (nothing called `/api/premium/*`), so none was invented. With the default `FREE_MAX_QUALITY=4320` nothing is locked. |
| Download progress / cancel API | ➖ not in the original either. Added: cancelling the request (closing the tab/connection) now kills yt-dlp. |

### Deliberately NOT migrated
* **`ytdlp.proxy` (residential proxy) and `ytdlp.cookies` (login cookies from a throwaway Instagram account).** These exist to get around YouTube/Instagram blocking and login walls. They are not carried over, and blocked requests now return honest errors ("YouTube is blocking this server…", "Instagram is requesting login…"). Expect some links to fail from datacenter IPs.
* Java tooling: `.github/modernize` hooks, `.vscode` Java settings, `test.mp4` (3.8 MB sample), `.git/`, Maven wrapper.

### Intentional behaviour changes (all small)
* Payments: redeemed payment IDs are now **persisted** (`DATA_DIR/premium-payments.json`). Before, a restart let the same payment be redeemed again for a fresh 30 days. On hosts with ephemeral disks (e.g. Render free tier) mount a persistent volume or move this to a database.
* Backend refuses to start in production with the placeholder/short `PREMIUM_TOKEN_SECRET` (was a log warning). Child processes never receive `RAZORPAY_*`/`PREMIUM_*` variables. Logs omit query strings (they hold media URLs and tokens).
* `POST /api/premium/order` returns 503 "Payments are not configured" with placeholder keys instead of a confusing Razorpay 502.
* Frontend: `instaPreviewUrl` now matches only `instagram.com` and its subdomains (the original also matched e.g. `evilinstagram.com`). Page title was the Vite default "inst".
* The original `index.css` (live `#root` centring, `h1/h2/p` rules, theme variables) is preserved in `globals.css`; Tailwind is installed with preflight **off** so the hand-written design renders identically. Existing class names are kept rather than converted to utilities.

## Security notes
Only fixed, server-built yt-dlp arguments are used; the client supplies just a regex-validated https URL (passed after `--`) and an integer quality / `mp3|m4a`. No shell, no client filenames or paths (`download.<ext>` only, work dir created with `mkdtemp`, deleted after streaming/abort/failure/shutdown; stale dirs swept hourly). Because only YouTube/Instagram hosts pass validation there is no arbitrary-URL fetching (SSRF). Razorpay secrets stay on the backend; prices come from config only.

**Legal:** downloading from YouTube/Instagram may violate their terms and copyright law. Only process content you own or have permission to download; the operator is responsible for that. No guarantee that any given public link will work.

## Tests — what was actually run (sandbox had **no network**, so `npm install` was impossible)
| Check | Result |
|---|---|
| Backend: URL policy, quality parser, rate limiter, semaphore/queue, **yt-dlp service against a stub `yt-dlp`** (info parsing, cache, timeouts, cancellation, concurrency 503, cleanup, shutdown), **premium service** (signature, token, replay, persistence, Razorpay order mocked) — 67 tests | ✅ **67/67 passed**, but executed through Node's built-in TS support with a minimal `vitest` shim, **not real Vitest** |
| Frontend: validation, formatting, API client with mocked `fetch` — 25 tests | ✅ 25/25 passed, same shim |
| Backend `test/app.test.ts` (HTTP routes, CORS, 429, premium flow), `test/config.test.ts` | ⚠️ **written, NOT run** (need real `fastify`/`zod`) |
| Frontend `DownloaderBox.test.tsx` (React Testing Library) | ⚠️ **written, NOT run** |
| `npm install`, `npm run typecheck`, `npm run build` (backend and frontend), real `vitest`, lockfiles | ❌ **NOT run** — no network. A best-effort `tsc` pass with stubbed third-party types showed no errors in the logic, only stub artifacts; it is not a real typecheck |
| Real yt-dlp against YouTube/Instagram, Razorpay sandbox, Docker build, browser/visual comparison with the old UI | ❌ **NOT run / not possible here** |
Expect a few small type or integration fixes on first `npm run typecheck`/`npm test`. No `package-lock.json` is included; `npm install` creates them.


## Troubleshooting: "Could not fetch this link"

That message only means yt-dlp failed on the server. The real reason is now printed in the **backend terminal** (`[yt-dlp info] exit=... stderr: ...`). Common fixes:

1. **Update yt-dlp** (most common): `pip install -U "yt-dlp[default]"` or `yt-dlp -U`. Old versions break often.
2. **YouTube**: install Deno (yt-dlp needs a JS runtime) and make sure `ffmpeg` is in PATH.
3. **Instagram "empty media response" / YouTube "not a bot"**: set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `YTDLP_COOKIES_FILE=path/to/cookies.txt`) in `backend/.env`, then restart the backend.

## Speed & accurate sizes

- `YTDLP_REUSE_INFO=true` (default): the download reuses the info fetched for the preview (no second extraction) and downloads the exact format whose size is shown. If that fast path fails it automatically falls back to the normal way.
- `YTDLP_ARIA2C=true` (optional): 16 parallel connections for much faster YouTube downloads. Install aria2 first (`winget install aria2.aria2`) and check `aria2c --version` works.


## Download flow (with live progress)

1. `GET /api/media/prepare?url=&quality=|&audio=` starts the download in the background and returns `{ jobId }`.
2. `GET /api/media/progress/:id` returns `{ status: preparing|downloading|merging|ready|error, percent }` (the site polls it every 0.5 s).
3. `GET /api/media/file/:id` sends the finished file; the browser's own download manager saves it.

The old `GET /api/media/download` still works. Files are deleted a few minutes after they were served.
Note: percent comes from yt-dlp's native downloader; with `YTDLP_ARIA2C=true` only a spinner is shown.
