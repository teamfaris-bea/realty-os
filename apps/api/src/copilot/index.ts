// api/copilot — the local-AI lead copilot (docs/copilot/COPILOT.md). Not yet mounted on a route or in the
// Providers bag: that wiring touches shared registration files and is left for the integration step.
export * from './model.js';
export * from './ollama.js';
export * from './sources.js';
export * from './run.js';
