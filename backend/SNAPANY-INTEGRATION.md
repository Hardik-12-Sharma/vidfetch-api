# SnapAny YouTube provider

VidFetch can use SnapAny for YouTube while continuing to use yt-dlp for Instagram, Facebook, and X.

## How routing works

- When `SNAPANY_API_KEY` is not set, all platforms keep using the existing yt-dlp service.
- When `SNAPANY_API_KEY` is set, YouTube metadata and downloads use SnapAny; the other platforms continue using yt-dlp.
- The existing media routes and frontend response shape remain unchanged.
- YouTube formats above 1080p are not listed because SnapAny's proxy-download endpoint supplies proxy URLs only up to 1080p. The provider may return higher-resolution direct URLs, but those are not used by the Render-hosted downloader because YouTube can block datacenter IPs.

## Credit usage

The implementation deliberately separates metadata preview from the actual download:

- Metadata preview calls `POST /openapi/v1/extract/post` (1 credit per successful call).
- Starting a YouTube download calls `POST /openapi/v1/youtube/proxy-download` (4 credits per 10 minutes of video, rounded up).
- Metadata and proxy responses are cached in memory for 20 minutes and concurrent identical requests are de-duplicated. A metadata preview does not consume the more expensive proxy-download credits.
- Proxy URLs are short-lived (typically 30–60 minutes). If a link expires, the user should start the download again so VidFetch can request fresh proxy links.

## Local setup

Add the API key to `backend/.env` only:

```env
SNAPANY_API_KEY=sk_snapany_your_key_here
```

Do not put this value in `frontend/.env`, browser code, GitHub, or a client-visible `NEXT_PUBLIC_*` variable.

The backend Docker image already installs FFmpeg. No additional Node package is required for SnapAny; the implementation uses Node 20+ `fetch` and the existing `ProcessRunner`.

## Render setup

1. Open the `vidfetch-api` Render service.
2. Open **Environment**.
3. Add an environment variable:
   - Key: `SNAPANY_API_KEY`
   - Value: your SnapAny API key
4. Save and deploy the service.
5. Leave `YTDLP_PATH`, FFmpeg, and the existing platform configuration in place. yt-dlp is still used for Instagram, Facebook, and X.
6. `YTDLP_WARMUP` is automatically disabled for yt-dlp when SnapAny is configured, because SnapAny now handles YouTube.

Keep the key on the backend only. If it is ever committed or shared, rotate it in the SnapAny console.

## Testing after deployment

1. Check `GET https://<your-backend>/api/health` returns `{"success":true,"status":"ok"}`.
2. Submit the same YouTube URL to the existing `/api/media/info` endpoint. The response should show qualities no higher than 1080p.
3. Start a download using the existing `/api/media/prepare` flow, poll `/api/media/progress/:id`, and retrieve `/api/media/file/:id` when ready.
4. Test one Instagram, Facebook, or X URL to confirm those requests still route through yt-dlp.

## Operational notes

- SnapAny's API key is never sent to the browser. Only VidFetch's backend calls the API.
- Proxy URLs are treated as temporary bearer links and are not logged or returned by VidFetch's own API.
- Video and audio streams are downloaded to the backend's temporary directory, merged with FFmpeg using stream copy where possible, and removed using the existing job cleanup lifecycle.
- `YTDLP_MAX_FILESIZE` is also the maximum combined SnapAny media download size.
- SnapAny availability, supported content, credits, and pricing are controlled by SnapAny. The integration cannot guarantee extraction of private, deleted, age-restricted, region-restricted, or otherwise unsupported content.
