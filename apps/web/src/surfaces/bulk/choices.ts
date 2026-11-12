// What the bulk sheet offers to choose for Assign and Start plan (parity module 64, closing the gap the
// cross-lane wiring left: ARCHITECTURE §20 "Bulk Assign and Start plan"). The server decides every person
// again at draft and at run time (module 63: can() per person, the ownership engine per assign, the approved
// version per enrollment), so these lists only keep a person from picking something that is bound to fail.
//
// Who (DATA_MODEL §12):
//   bulk.assign  Owner/Admin to any member; a Team Lead to their team; never an agent, ISA or TC
//   bulk.run     tag, untag, stage, enroll (Start plan), email: every role but the TC
// Assign to whom (can('bulk.assign') + the engine's target rule, R-OWN-18, R-PERM-15): an active member who
// can hold leads, never a TC; a Team Lead only themself and the members of teams they lead.
// Which plan (R-PAR-16, R-PAR-35): one with an approved version (an enrollment runs only from one), never the
// instant reply to new leads (it starts on a new lead only), and either a team plan or the viewer's OWN
// personal plan, which covers only the people they own (the server skips anyone else as not permitted).
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi, useSession } from '../../shell/index.js';
import type { Member, MembersResponse, Playbook } from '../admin/lib/types.js';

export const ASSIGN_ROLES: readonly string[] = ['owner', 'admin', 'team_lead'];
export const RUN_ROLES: readonly string[] = ['owner', 'admin', 'team_lead', 'agent', 'isa'];

/** May this role bulk-assign at all (the People bar shows Assign)? */
export const mayBulkAssign = (role: string | null | undefined): boolean => role != null && ASSIGN_ROLES.includes(role);
/** May this role start a plan for people in bulk (the People bar shows Start plan)? */
export const mayBulkEnroll = (role: string | null | undefined): boolean => role != null && RUN_ROLES.includes(role);

export interface AssignTarget {
  userId: string;
  name: string;
  you: boolean;
}

const byName = (a: AssignTarget, b: AssignTarget) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);

/** Owner/Admin (GET /members): every active member who can hold leads, never a TC. */
export function assignTargetsFromMembers(members: readonly Pick<Member, 'userId' | 'displayName' | 'role' | 'status'>[], me: string | undefined): AssignTarget[] {
  return members
    .filter((m) => m.status === 'active' && m.role !== 'tc')
    .map((m) => ({ userId: m.userId, name: m.displayName.trim() || 'Unnamed member', you: m.userId === me }))
    .sort(byName);
}

/**
 * A Team Lead (GET /team/scoreboard): the server already lists exactly themself and the active members of the
 * teams they lead who can hold leads (never a TC), which is who a Team Lead may assign to.
 */
export function assignTargetsFromTeam(rows: readonly { userId: string; name: string | null }[], me: string | undefined): AssignTarget[] {
  return rows.map((m) => ({ userId: m.userId, name: m.name?.trim() || 'Unnamed member', you: m.userId === me })).sort(byName);
}

export interface PlanChoice {
  id: string;
  name: string;
  kind: string;
  scope: 'team' | 'agent';
}

/**
 * The plans Start plan offers: approved, not the instant reply to new leads, not module 26's alerts or call answering
 * (bulk/service.ts refuses those three; batch 7 review ui/F2), a team plan or the viewer's own.
 */
const NOT_ENROLLABLE: readonly string[] = ['new_lead_response', 'trigger', 'voice_answering'];
export function planChoices(playbooks: readonly Pick<Playbook, 'id' | 'name' | 'kind' | 'scope' | 'ownerUserId' | 'approvedVersionId'>[], me: string | undefined): PlanChoice[] {
  return playbooks
    .filter((p) => p.approvedVersionId !== null && !NOT_ENROLLABLE.includes(p.kind) && (p.scope === 'team' || (me !== undefined && p.ownerUserId === me)))
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, scope: p.scope }))
    .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'team' ? -1 : 1));
}

/** The people this viewer may bulk-assign to (none for a role that may not). */
export function useAssignTargets(role: string | null | undefined) {
  const api = useApi();
  const { session } = useSession();
  const me = session?.user.id;
  const tenantWide = role === 'owner' || role === 'admin';
  return useQuery<AssignTarget[], ApiError>({
    queryKey: ['bulk', 'assign-targets', role ?? null, me ?? null],
    enabled: mayBulkAssign(role),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (tenantWide) return assignTargetsFromMembers((await api.get<MembersResponse>('/members', { signal })).members, me);
      return assignTargetsFromTeam((await api.get<{ members: { userId: string; name: string | null }[] }>('/team/scoreboard?range=today', { signal })).members, me);
    },
  });
}

/** The plans this viewer may start for people in bulk (GET /playbooks, the same cache as Settings → Playbooks). */
export function usePlanChoices(enabled: boolean) {
  const api = useApi();
  const { session } = useSession();
  const me = session?.user.id;
  return useQuery<{ playbooks: Playbook[] }, ApiError, PlanChoice[]>({
    queryKey: ['assistant', 'playbooks'],
    enabled,
    queryFn: ({ signal }) => api.get<{ playbooks: Playbook[] }>('/playbooks', { signal }),
    select: (r) => planChoices(r.playbooks, me),
  });
}
