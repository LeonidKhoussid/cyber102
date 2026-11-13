import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = process.env.API_ORIGIN ?? 'http://127.0.0.1:3001';
const proxy = Object.fromEntries(['/api', '/openapi.json', '/health', '/metrics'].map(path => [path, { target }]));

export default defineConfig({
  root,
  server: { port: 3000, strictPort: true, proxy },
  preview: { port: 3000, strictPort: true, proxy },
});
