// Contact page section slots (PARITY_PLAN §4.3: owned by module 58; modules 61 and 64 add one entry each).
//
// SHARED REGISTRATION FILE. A module adds ONE import line and ONE entry, above the marker. Each entry is a
// component rendered on the full contact view (never on a pond or offer card: R-PERM-6), in `order`.
import { type ComponentType, createElement, Fragment } from 'react';
import type { ContactFullView } from '../feed/lib/types.js';
import { PeopleSections } from '../people-edit/PeopleSections.js';

export interface ContactSection {
  id: string;
  /** lower first */
  order: number;
  component: ComponentType<{ contact: ContactFullView }>;
}

export const contactSections: ContactSection[] = [
  { id: 'people', order: 10, component: PeopleSections },
  // registry: add new entries above this line
];

/** Renders every registered section for the full contact view. */
export function ContactSections({ contact }: { contact: ContactFullView }) {
  return createElement(
    Fragment,
    null,
    ...[...contactSections].sort((a, b) => a.order - b.order).map((s) => createElement(s.component, { key: s.id, contact })),
  );
}
