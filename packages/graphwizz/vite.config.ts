import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ rollupTypes: false, include: ['src/index.ts', 'src/cypherlite/index.ts', 'src/render/index.ts'] })],
  build: {
    lib: {
      entry: {
        graphwizz: 'src/index.ts',
        cypherlite: 'src/cypherlite/index.ts',
        renderers: 'src/render/index.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^d3-/],
    },
    target: 'es2022',
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
