import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const httpsEnabled = process.env.HAIR_COMPARE_HTTPS === '1';
export default defineConfig({
  plugins: [react()],
  worker: { format: 'iife' },
  server: {
    port: httpsEnabled ? 5174 : 5173, strictPort: true,
    https: httpsEnabled ? {
      cert: readFileSync(process.env.HAIR_COMPARE_HTTPS_CERT!),
      key: readFileSync(process.env.HAIR_COMPARE_HTTPS_KEY!),
    } : undefined,
    proxy: { '/ai-proxy': { target: 'http://127.0.0.1:8000', rewrite: path => path.replace(/^\/ai-proxy/, '') } },
  },
  test: { include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'] },
});
