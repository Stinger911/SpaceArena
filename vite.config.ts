import { defineConfig } from 'vite';

// base './' — игра лежит в /g/space-arena/ на Cardputer и в любой подпапке при локальной раздаче.
// Один бандл с коротким именем: на SD-карте и в запросах меньше мелких файлов.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'c-[hash:6].js',
        assetFileNames: '[name][extname]',
        codeSplitting: false,
      },
    },
  },
});
