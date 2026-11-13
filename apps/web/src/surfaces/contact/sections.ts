// Contact page section slots (PARITY_PLAN §4.3: owned by module 58; modules 61 and 64 add one entry each).
//
// SHARED REGISTRATION FILE. A module adds ONE import line and ONE entry, above the marker. Each entry is a
// component rendered on the full contact view (never on a pond or offer card: R-PERM-6), in `order`. An entry
// with `slot: 'details'` renders inside the Details section instead (PARITY_PLAN §5: custom fields are part of
// the person's Details; slots.ts).
import { type ComponentType, createElement, Fragment } from 'react';
import type { ContactFullView } from '../feed/lib/types.js';
import { PeopleSections } from '../people-edit/PeopleSections.js';
import { ContactFieldsSection } from '../people/ContactFields.js';
import { ContactTagsSection } from '../people/ContactTags.js';
import { DetailsSlotContext } from './slots.js';
import { HomeownerPanel } from '../homeowner/HomeownerPanel.js';
import { AiCarePanelSection } from '../aiCare/Person.js';

export interface ContactSection {
  id: string;
  /** lower first */
  order: number;
  /** where it renders: the page (default) or inside the Details section */
  slot?: 'details';
  component: ComponentType<{ contact: ContactFullView }>;
}

export const contactSections: ContactSection[] = [
  { id: 'people', order: 10, component: PeopleSections },
  { id: 'tags', order: 5, component: ContactTagsSection },
  { id: 'fields', order: 20, slot: 'details', component: ContactFieldsSection },
  { id: 'homeowner', order: 30, component: HomeownerPanel },
  { id: 'ai-care', order: 1, component: AiCarePanelSection },
  // registry: add new entries above this line
];

/** Renders every registered section for the full contact view (the Details slot's entries inside Details). */
export function ContactSections({ contact }: { contact: ContactFullView }) {
  const sorted = [...contactSections].sort((a, b) => a.order - b.order);
  const details = sorted.filter((s) => s.slot === 'details').map((s) => ({ id: s.id, component: s.component }));
  return createElement(
    DetailsSlotContext.Provider,
    { value: details },
    createElement(Fragment, null, ...sorted.filter((s) => s.slot !== 'details').map((s) => createElement(s.component, { key: s.id, contact }))),
  );
}
