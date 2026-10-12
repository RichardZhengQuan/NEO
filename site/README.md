# NEO homepage

A one-screen homepage in the first-run guide's red/bone print style. It is plain HTML, CSS and JavaScript with no build step and no third-party requests, so any static host can serve this folder as it is (GitHub Pages, Netlify, Cloudflare Pages, nginx).

Preview it locally:

```bash
python3 -m http.server 7795 --directory site
```

Then open http://127.0.0.1:7795.

- `main.js` ports the guide's avatar orbit (`packages/ui/src/avatar/use-avatar-orbit.ts`, `orbit-geometry.ts`), the figure's ink glitch (`neo-figure.tsx`), the wordmark fit (`apps/web/src/components/cyber/PrintWordmark.tsx`) and the typed terminal line. Keep them in step when the guide changes.
- `assets/figures` are copies of `packages/ui/assets/avatar-figures`; `assets/portraits` are the portraits embedded in `packages/ui/src/avatar/portraits.data.ts`, written out as files.
- The copy is English and Simplified Chinese (`STRINGS` in `main.js`). The page follows the browser language and remembers a manual switch.
