// R-ISA-15 permissions: aiCare/controls.ts against core can() for every role × own / collaborator / team (Q11).
import { type Actor, can } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { controlsFor, hasControl } from './controls.js';

const ROLES = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const;
const ME = '01900000-0000-7000-8000-0000000000aa';
const OTHER = '01900000-0000-7000-8000-0000000000bb';
const T = '01900000-0000-7000-8000-000000000001';
const actor = (role: (typeof ROLES)[number]) => ({ kind: 'user', userId: ME, tenantId: T, role, sessionId: 's' }) as unknown as Actor;
const RELS = { own: { own: true }, collab: { collaborator: true }, team: { team: true } } as const;

describe('R-ISA-15 controls (module 76)', () => {
  for (const role of ROLES) {
    for (const [rel, facts] of Object.entries(RELS)) {
      it(`R-ISA-15 E496: ${role} on a ${rel} lead: the controls shown, live and paused, are exactly what core can() allows`, () => {
        const f = { tenantId: T, ...facts, reauth: { reauthenticatedAt: Date.now(), now: Date.now() } } as never;
        const view = can(actor(role), 'ai_isa.view', f).ok;
        const owner = rel === 'own' ? ME : OTHER;
        const live = controlsFor({ role, viewerUserId: ME, ownerUserId: owner, state: 'live', undoOpen: false, canResume: false });
        const paused = controlsFor({ role, viewerUserId: ME, ownerUserId: owner, state: 'paused', undoOpen: false, canResume: rel === 'own' });
        const undo = controlsFor({ role, viewerUserId: ME, ownerUserId: owner, state: 'paused', undoOpen: true, canResume: false });
        if (!view) {
          // a role that cannot see the panel never gets one to render controls on (R-PERM-5); for tc nothing at all
          if (role === 'tc') expect(live).toEqual({ pause: false, takeOver: false, end: false, undo: false, resume: false });
          return;
        }
        expect(live.pause).toBe(can(actor(role), 'ai_isa.pause', f).ok);
        expect(live.takeOver).toBe(can(actor(role), 'ai_isa.control', f).ok);
        expect(live.end).toBe(can(actor(role), 'ai_isa.control', f).ok);
        expect(undo.undo).toBe(can(actor(role), 'ai_isa.control', f).ok);
        expect(undo.takeOver || undo.end || undo.resume).toBe(false);
        // Resume: the owner only, and only when the panel says canResume
        expect(paused.resume).toBe(rel === 'own' && can(actor(role), 'ai_isa.resume', f).ok);
        // E496 (batch 13 isa-4 F10): Take over and End stay on a paused assignment (a human_contact pause included)
        expect(paused.takeOver).toBe(can(actor(role), 'ai_isa.control', f).ok);
        expect(paused.end).toBe(can(actor(role), 'ai_isa.control', f).ok);
        expect(paused.pause).toBe(false);
      });
    }
  }

  it('R-ISA-15: Resume for the owner only when canResume holds', () => {
    expect(controlsFor({ role: 'agent', viewerUserId: ME, ownerUserId: ME, state: 'paused', undoOpen: false, canResume: false }).resume).toBe(false);
    expect(controlsFor({ role: 'agent', viewerUserId: ME, ownerUserId: ME, state: 'paused', undoOpen: false, canResume: true }).resume).toBe(true);
    expect(controlsFor({ role: 'owner', viewerUserId: ME, ownerUserId: OTHER, state: 'paused', undoOpen: false, canResume: true }).resume).toBe(false);
  });

  it('R-ISA-15: no Take over, End or Undo for a collaborating agent or the human isa role', () => {
    for (const role of ['agent', 'isa'] as const) {
      expect(hasControl(role, ME, OTHER)).toBe(false);
      const c = controlsFor({ role, viewerUserId: ME, ownerUserId: OTHER, state: 'live', undoOpen: false, canResume: null });
      expect([c.takeOver, c.end]).toEqual([false, false]);
      expect(controlsFor({ role, viewerUserId: ME, ownerUserId: OTHER, state: 'paused', undoOpen: true, canResume: null }).undo).toBe(false);
    }
    expect(hasControl('isa', ME, ME)).toBe(false);
  });

  it('R-ISA-15: nothing for tc or support, and nothing on an ended assignment', () => {
    const none = { pause: false, takeOver: false, end: false, undo: false, resume: false };
    expect(controlsFor({ role: 'tc', viewerUserId: ME, ownerUserId: ME, state: 'live', undoOpen: false, canResume: true })).toEqual(none);
    expect(controlsFor({ role: 'owner', viewerUserId: ME, ownerUserId: ME, state: 'live', undoOpen: false, canResume: true, support: true })).toEqual(none);
    expect(controlsFor({ role: 'owner', viewerUserId: ME, ownerUserId: ME, state: 'ended', undoOpen: false, canResume: true })).toEqual(none);
  });
});
