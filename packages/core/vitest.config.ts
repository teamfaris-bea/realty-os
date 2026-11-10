import { defineConfig } from 'vitest/config';
import { realtyVitest } from '../../vitest.shared.js';

export default defineConfig(
  realtyVitest({
    environment: 'node',
    coverageInclude: ['src/**/*.ts'],
  }),
);
