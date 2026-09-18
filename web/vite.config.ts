import { defineConfig } from 'vite'

// Dev server proxies /api to the Go backend so the browser talks to one origin
// (no CORS). Run `go run ./cmd/server` alongside `npm run dev`.
//
// The target is overridable via GMP_API_TARGET, since :8080 is often taken
// (e.g. by Docker). Example:
//   go run ./cmd/server -addr :8085
//   GMP_API_TARGET=http://localhost:8085 npm run dev
const apiTarget = process.env.GMP_API_TARGET ?? 'http://localhost:8080'

// VITE_BASE lets the GitHub Pages build serve from /go-scheduler-live/ (see
// .github/workflows/pages.yml); local builds keep the root base.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: {
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // Pixi canvas scene is intentionally omitted from unit tests in favor of pure logic tests
      exclude: ['src/scene/**', 'node_modules/**', 'dist/**'],
    },
  },
})
