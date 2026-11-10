import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { realtyVitest } from '../../vitest.shared.js';

const base = realtyVitest({ environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] });
export default defineConfig({ ...base, plugins: [react()] });
