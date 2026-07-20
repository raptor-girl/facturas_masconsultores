import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // necesario para que el contenedor sea accesible desde el host
    port: Number(process.env['WEB_PORT'] ?? 5173),
  },
  preview: { host: true, port: Number(process.env['WEB_PORT'] ?? 5173) },
  build: { outDir: 'dist', sourcemap: true },
});
