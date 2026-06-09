# Workspace AAF Signer Worker

Cloudflare Worker relay for the public Accountability signing page.

## Deploy

```bash
cd signing-cloudflare-worker
npm create cloudflare@latest -- --existing-script
wrangler secret put TURSO_DATABASE_URL
wrangler secret put TURSO_AUTH_TOKEN
wrangler deploy
```

Set `ALLOWED_ORIGIN` in `wrangler.toml` to your GitHub Pages origin, for example:

```toml
ALLOWED_ORIGIN = "https://reymarkcabil.github.io"
```

The public endpoints are:

- `GET /form?code=SIGNING_CODE`
- `POST /sign`
- `GET /health`

