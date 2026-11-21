// How a task row on the contact timeline reads. The view stores `kind:status` and the title.
const KIND_WORD: Record<string, string> = {
  todo: 'Task',
  callback: 'Call back',
  promise: 'Promise',
  follow_up: 'Follow-up',
  document: 'Document',
};

/** The timeline sentence for a task item. Null when the row is not a task detail. */
export function taskTimelineText(detail: string | null, preview: string | null): string | null {
  if (!detail || !detail.includes(':')) return null;
  const [kind, status] = detail.split(':');
  const word = KIND_WORD[kind ?? ''] ?? 'Task';
  const title = preview?.trim() || word;
  if (status === 'done' && kind === 'promise') return `Promise kept: ${title}`;
  if (status === 'done') return `Done: ${title}`;
  if (status === 'canceled') return `Canceled: ${title}`;
  return `${word}: ${title}`;
}
