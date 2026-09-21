import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// `vite preview` is the production server here (Cloudflare reverse-proxies onto it), so two things it does by
// default have to be corrected in it rather than in a host config that does not exist:
//
//  1. Its SPA fallback answers `/slice` with the ROOT index.html — a path with no extension and no trailing
//     slash never reaches the static handler — so the per-route HTML entries would build and then never be
//     served to anyone, crawler or visitor.
//  2. It sends `cache-control: no-cache` for everything, which for this app means re-downloading a 4MB kernel
//     on every visit. Asset names are content-hashed and can be cached forever; the HTML must not be, or a
//     deploy never reaches anyone.
// /docs/* are static articles: they are HTML entries with no script tag, so they never boot the SPA.
const ROUTE_HTML = {
  '/slice': '/slice/index.html',
  '/demos': '/demos/index.html',
  '/about': '/about/index.html',
  '/license': '/license/index.html',
  '/docs/licensing': '/docs/licensing/index.html',
  '/docs': '/docs/index.html',
  '/docs/orcaslicer-webassembly-port': '/docs/orcaslicer-webassembly-port/index.html',
}

const routeHtmlMiddleware = (req, res, next) => {
  const [path] = (req.url || '/').split('?')
  const entry = ROUTE_HTML[path.replace(/\/$/, '')]
  if (entry) req.url = entry
  else if (path.startsWith('/assets/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  next()
}

const serveRouteHtml = {
  name: 'serve-route-html',
  // Both servers, so `npm run dev` shows the head that actually ships for that route rather than the landing one.
  configureServer(server) { server.middlewares.use(routeHtmlMiddleware) },
  configurePreviewServer(server) { server.middlewares.use(routeHtmlMiddleware) },
}

export default defineConfig({
  plugins: [react(), serveRouteHtml],
  // Workspace hoisting collapses react to a single copy in web/node_modules, so absolute-path aliases are unnecessary.
  //  Only dedupe is kept, which guarantees a single instance even if an app-local copy appears.
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  worker: { format: 'es' },   // needed for the worker's dynamic st/mt selection (code splitting) and the mt glue's top-level await
  build: {
    target: 'es2022',   // top-level await in the mt glue (emscripten pthread) — Chrome 89+/Safari 15+
    // Three HTML entries, not one. A single index.html served under every path gives every route the same
    // title, description and canonical, so a crawler sees one page and two duplicates of it — and the two
    // that describe the tool itself are exactly the ones worth finding. Each entry boots the same bundle;
    // the router still reads the path.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        slice: resolve(__dirname, 'slice/index.html'),
        demos: resolve(__dirname, 'demos/index.html'),
        about: resolve(__dirname, 'about/index.html'),
        docsWasmPort: resolve(__dirname, 'docs/orcaslicer-webassembly-port/index.html'),
        license: resolve(__dirname, 'license/index.html'),
        docsLicensing: resolve(__dirname, 'docs/licensing/index.html'),
        docs: resolve(__dirname, 'docs/index.html'),
      },
    },
  },

  // COOP/COEP -> crossOriginIsolated -> the worker picks the mt kernel automatically (-pthread, 2.2x). Without them it still runs on st.
  server: {
    // No fs.allow needed — Vite detects the workspaces in the root package.json and allows the whole repository by default
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    // Allows the reverse-proxy domain. Add more hosts as a comma-separated ALLOWED_HOSTS in .env.
    allowedHosts: (process.env.ALLOWED_HOSTS || 'slicer.kimgh06.com').split(','),
  },
})
