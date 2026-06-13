// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths — deployable under any URL prefix
  server: {
    fs: { allow: ['.'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
