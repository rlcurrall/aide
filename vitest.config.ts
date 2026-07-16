import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cli': fromRoot('./src/cli'),
      '@lib': fromRoot('./src/lib'),
      '@schemas': fromRoot('./src/schemas'),
    },
  },
  test: {
    include: ['src/**/*.vitest.ts'],
    environment: 'node',
    globals: false,
    watch: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
