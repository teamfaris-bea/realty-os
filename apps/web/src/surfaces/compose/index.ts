// Compose surface (web/agent): the compose box (ComposeBox.tsx) lives inside the thread page, so
// composing is never a separate place to go. It registers no page of its own.
import type { SurfaceModule } from '../../shell/index.js';

export const surface: SurfaceModule = { pages: [] };
