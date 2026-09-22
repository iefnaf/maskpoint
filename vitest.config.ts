import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Tests run against source, so they never depend on a build having happened. `@maskpoint/dsh`
    // and `@maskpoint/pi` are aliased too: the cross-platform parity corpus test drives both
    // adapters directly (see packages/corpus/test/parity.test.ts).
    alias: {
      '@maskpoint/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@maskpoint/dsh': fileURLToPath(new URL('./packages/dsh/src/index.ts', import.meta.url)),
      '@maskpoint/pi': fileURLToPath(new URL('./packages/pi/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
