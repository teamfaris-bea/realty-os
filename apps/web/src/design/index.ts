// The design system (web/shell). Surfaces import from here, never from individual files.
export { Icon, ICON_NAMES, type IconName } from './Icon.js';
export { Button, ButtonLink, Spinner, buttonClass, type ButtonProps, type ButtonVariant } from './Button.js';
export { TextField, type TextFieldProps } from './Field.js';
export { Card, EmptyState, Notice, Ratio, type NoticeTone } from './Surface.js';
export { Dialog, type DialogProps } from './Dialog.js';
export { Announcer, announce, countdownMilestone, milestoneWords, useCountdownAnnouncement } from './Announce.js';
export { GateBadge, type GateDecisionView, type GateOutcome } from './GateBadge.js';
export {
  CheckThis,
  ClaimLine,
  EvidenceLink,
  EvidenceRoutesProvider,
  evidenceText,
  formatEvidenceLine,
  type ClaimView,
  type EvidenceRefView,
  type EvidenceRouteFn,
  type EvidenceRoutes,
  type EvidenceSourceType,
} from './Evidence.js';
