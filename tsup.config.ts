import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['audioInfo.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
})
