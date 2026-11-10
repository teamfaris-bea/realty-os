// Teams and team members (RLS: members read, Owner/Admin write). team_members.is_lead gives a Team
// Lead their scope (app.my_team_member_ids, which also requires the team_lead role).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface TeamRow {
  id: string;
  name: string;
  is_default: boolean;
}

export async function listTeams(tx: Tx): Promise<TeamRow[]> {
  return (await sql<TeamRow>`SELECT id, name, is_default FROM teams WHERE tenant_id = app.tenant_id() ORDER BY is_default DESC, name, id`.execute(tx)).rows;
}

export async function getTeam(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<TeamRow | null> {
  const lock = opts.forUpdate ? sql`FOR UPDATE` : sql``;
  return (await sql<TeamRow>`SELECT id, name, is_default FROM teams WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid ${lock}`.execute(tx)).rows[0] ?? null;
}

export async function teamMembers(tx: Tx, teamIds: readonly string[]): Promise<{ team_id: string; user_id: string; is_lead: boolean }[]> {
  if (teamIds.length === 0) return [];
  return (
    await sql<{ team_id: string; user_id: string; is_lead: boolean }>`
      SELECT team_id, user_id, is_lead FROM team_members WHERE tenant_id = app.tenant_id() AND team_id = ANY (${[...teamIds]}::uuid[])
       ORDER BY team_id, user_id`.execute(tx)
  ).rows;
}

export async function insertTeam(tx: Tx, id: string, name: string): Promise<void> {
  await sql`INSERT INTO teams (tenant_id, id, name) VALUES (app.tenant_id(), ${id}::uuid, ${name})`.execute(tx);
}

export async function renameTeam(tx: Tx, id: string, name: string): Promise<void> {
  await sql`UPDATE teams SET name = ${name} WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function makeDefault(tx: Tx, id: string): Promise<string | null> {
  const old = await sql<{ id: string }>`UPDATE teams SET is_default = false WHERE tenant_id = app.tenant_id() AND is_default AND id <> ${id}::uuid RETURNING id`.execute(tx);
  await sql`UPDATE teams SET is_default = true WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return old.rows[0]?.id ?? null;
}

export async function deleteTeam(tx: Tx, id: string): Promise<void> {
  await sql`DELETE FROM teams WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function replaceTeamMembers(tx: Tx, teamId: string, members: readonly { userId: string; isLead: boolean }[]): Promise<void> {
  await sql`DELETE FROM team_members WHERE tenant_id = app.tenant_id() AND team_id = ${teamId}::uuid`.execute(tx);
  for (const m of members) {
    await sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (app.tenant_id(), ${teamId}::uuid, ${m.userId}::uuid, ${m.isLead})`.execute(tx);
  }
}
