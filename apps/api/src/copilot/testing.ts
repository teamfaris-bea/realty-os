// A deterministic local model for tests and dev: answers each prompt key from a script.
import type { CopilotPrompt } from '@realty/core/copilot';
import type { CopilotModel, CopilotModelAnswer } from './model.js';

export class FakeCopilotModel implements CopilotModel {
  readonly locality = 'local' as const;
  readonly modelId = 'fake-local';
  readonly prompts: CopilotPrompt[] = [];
  constructor(private readonly answers: Partial<Record<CopilotPrompt['key'], string | Error>>) {}
  async complete(p: CopilotPrompt): Promise<CopilotModelAnswer> {
    this.prompts.push(p);
    const a = this.answers[p.key];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error('no scripted answer');
    return { text: a, model: this.modelId };
  }
}
