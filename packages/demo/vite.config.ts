import { defineConfig } from 'vite'

// The demo consumes the library from source via the "development" export
// condition, so workers and modules are bundled first-class by Vite.
export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  server: {
    port: 5173,
    // Fallback proxy for Neo4j servers that do not send CORS headers.
    // Configure with env vars when running `vite`:
    //   NEO4J_PROXY_TARGET=https://my-server:7473 vite
    proxy: {
      '/neo4j-proxy': {
        target: process.env.NEO4J_PROXY_TARGET || 'https://demo.neo4jlabs.com:7473',
        changeOrigin: true,
        secure: false,
        rewrite: (p: string) => p.replace(/^\/neo4j-proxy/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
})
