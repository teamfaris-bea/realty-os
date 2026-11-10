// A small inline-SVG icon set (no icon font, no network). Icons are decorative by default
// (aria-hidden); pass `label` when an icon is the only content of a control.
import type { ReactElement } from 'react';

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  feed: 'M4 5h16M4 12h16M4 19h10',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm5.2 12.2L21 21',
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  person: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm-8 9a8 8 0 0 1 16 0',
  check: 'M4 12.5 9.5 18 20 6',
  checklist: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
  message: 'M4 5h16v11H8l-4 4z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  pond: 'M3 15c3 0 3-2 6-2s3 2 6 2 3-2 6-2M3 19c3 0 3-2 6-2s3 2 6 2 3-2 6-2M12 3v7',
  deal: 'M3 12l4-4 5 5 3-3 6 6M14 16h7v-7',
  listing: 'M3 11 12 4l9 7M5 10v10h14V10M10 20v-5h4v5',
  team: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  alert: 'M12 3 2 20h20zM12 10v4M12 17v.5',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5v.5',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
  block: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM5.6 5.6l12.8 12.8',
  question: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  more: 'M5 12h.5M12 12h.5M19 12h.5',
  chevron: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10',
  play: 'M7 4v16l13-8z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon(props: { name: IconName; size?: number; label?: string; className?: string }): ReactElement {
  const size = props.size ?? 22;
  const labelled = props.label !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      {...(labelled ? { role: 'img', 'aria-label': props.label } : { 'aria-hidden': true, focusable: false })}
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
