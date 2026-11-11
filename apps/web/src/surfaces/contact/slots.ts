// The Details section's slot (PARITY_PLAN §5: the person's Details section holds custom fields, addresses,
// relationships and collaborators). A section registered in sections.ts with `slot: 'details'` renders inside
// module 58's Details region, where DetailsSection places <DetailsSlots/>. The registry hands the entries over
// through this context, so DetailsSection never imports the registry (which imports it: no import cycle).
import { type ComponentType, Fragment, createContext, createElement, useContext } from 'react';
import type { ContactFullView } from '../feed/lib/types.js';

export interface SlotEntry {
  id: string;
  component: ComponentType<{ contact: ContactFullView }>;
}

export const DetailsSlotContext = createContext<readonly SlotEntry[]>([]);

/** The sections registered for the Details slot, in registry order (nothing outside a ContactSections tree). */
export function DetailsSlots({ contact }: { contact: ContactFullView }) {
  const entries = useContext(DetailsSlotContext);
  return createElement(Fragment, null, ...entries.map((s) => createElement(s.component, { key: s.id, contact })));
}
