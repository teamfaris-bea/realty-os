// Which AI care controls a viewer sees (R-ISA-15; docs/AI_ISA.md §3.5; Q11). Pure; controls.test.ts checks it against
// core can() for every role × own / collaborator / team. The server authorizes every call regardless.
// - Pause: whoever sees the panel, except support (ai_isa.view and ai_isa.pause have the same scopes, authz.ts:683, :685).
// - Take over, End and Undo: Owner, Admin and Team Lead, plus an agent who owns the assignment (ai_isa.control :687).
//   Collaborators and the human ISA role get Pause only.
// - Resume: the lead's owner only, when the panel says canResume (on list rows: the row's owner).
// - Start: the panel's canStart.
// While the Undo window is open, viewers with control see Undo in place of Take over and End, and nobody sees Resume.
import type { Role } from '@realty/core/foundation';

export interface ControlInput {
  role: Role | null | undefined;
  viewerUserId: string | null | undefined;
  /** the assignment's owner */
  ownerUserId: string;
  state: 'live' | 'paused' | 'ended';
  /** panel.assignment.undoUntil is in the future (or the local toast is open) */
  undoOpen: boolean;
  /** panel.canResume; on a list row, null (the row's owner decides) */
  canResume: boolean | null;
  support?: boolean;
}

export interface Controls {
  pause: boolean;
  takeOver: boolean;
  end: boolean;
  undo: boolean;
  resume: boolean;
}

export const NONE: Controls = { pause: false, takeOver: false, end: false, undo: false, resume: false };

export function hasControl(role: Role | null | undefined, viewerUserId: string | null | undefined, ownerUserId: string): boolean {
  if (role === 'owner' || role === 'admin' || role === 'team_lead') return true;
  return role === 'agent' && !!viewerUserId && viewerUserId === ownerUserId;
}

export function controlsFor(i: ControlInput): Controls {
  if (!i.role || i.role === 'tc' || i.support) return NONE;
  if (i.state === 'ended') return NONE;
  const ctl = hasControl(i.role, i.viewerUserId, i.ownerUserId);
  const isOwner = !!i.viewerUserId && i.viewerUserId === i.ownerUserId;
  if (i.undoOpen) return { ...NONE, undo: ctl };
  return {
    pause: i.state === 'live',
    takeOver: ctl,
    end: ctl,
    undo: false,
    // ai_isa.resume: the owner, admin, team lead or agent who owns it (the human isa role has no grant)
    resume: i.state === 'paused' && isOwner && i.role !== 'isa' && (i.canResume === null ? true : i.canResume),
  };
}
