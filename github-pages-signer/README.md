# Workspace AAF GitHub Pages Signer

Static public signing page for Accountability forms.

## Setup

1. Create a GitHub repo, for example `workspace-signer`.
2. Upload `index.html` and `config.js` to the repo root.
3. In `config.js`, replace `API_BASE` with your Cloudflare Worker URL.
4. Enable GitHub Pages for the repo.

The final signing URL format is:

```text
https://YOUR_GITHUB_USERNAME.github.io/workspace-signer/?code=SIGNING_CODE
```

