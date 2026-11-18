# Daily social video integration

Publishing remains disabled. Do not remove `.state/STOP`, enable the GitHub workflow,
or set either publishing flag to true until the owner explicitly requests activation.

One video is planned per day at 15:00 Asia/Qyzylorda. Kazakh on 2026-11-18,
Russian the following day, then alternating. Material, quiz, and tip formats rotate.
The same verified MP4 is uploaded once to Cloudinary and sent to both Buffer channels.
YouTube keeps its existing direct uploader.

Every TikTok caption ends with Instagram and YouTube profile links. Every
Instagram caption ends with TikTok and YouTube profile links. Addresses are
configured in `social-links.json`; the footer heading follows the video's
Kazakh/Russian language. The full caption including links is length-checked.

Credentials belong in ignored `.env.local` locally and GitHub Actions secrets remotely:
`BUFFER_API_TOKEN`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
`CLOUDINARY_CLOUD_NAME` is also required (GitHub repository variable).
Never put credential values in automation.json, logs, screenshots, or commits.

Read-only connection check: `node ustazon/daily.mjs social-check`.
Tests: `node --test ustazon/test/social.test.mjs` and `npm run test:ustazon`.

Buffer requests explicitly use automatic publishing and AI disclosure. Local
and encrypted remote state save each intent before createPost. A timeout after
creation leaves an uncertain intent; the bot will not create another post for
that platform. An operator must reconcile it with Buffer history. Confirmed
post IDs cannot be erased from SQLite. Platform errors never re-create a post
that already succeeded on the other platform. Older videos are not backfilled.

The existing reviewed story bank is finite. When exhausted, generation stops
with CONTENT_EXHAUSTED instead of repeating old videos. Add reviewed material
to continue. Account token expiry and disconnected channels also need attention.

References: https://developers.buffer.com/reference.md and
https://cloudinary.com/documentation/upload_images#generating_authentication_signatures
