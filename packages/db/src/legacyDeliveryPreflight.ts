// Operator-only diagnostic. No migration, application route, state restoration or provider call.
import pg from 'pg';

export interface LegacyReportOptions { tenantId: string; limit?: number; afterMessageId?: string }
export interface LegacyDependency { kind: 'assistant_action' | 'shared_fact' | 'turn' | 'handoff'; id: string; status: string }
export interface LegacyDeliveryReport {
  version: 1;
  tenantId: string;
  snapshotAt: string;
  readOnly: true;
  releaseReady: false;
  drainVerified: false;
  scope: 'failed_unresolved_without_provider_evidence';
  pageAfterMessageId: string | null;
  pageLimit: number;
  totalCandidates: number;
  totalBlockedMessages: number;
  messages: { messageId: string; dependencies: LegacyDependency[] }[];
  truncated: boolean;
  nextAfterMessageId: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ERRORS = new Set(['LEGACY_REPORT_INVALID_SCOPE','LEGACY_REPORT_OPERATOR_ROLE_REQUIRED','LEGACY_REPORT_TENANT_NOT_FOUND','LEGACY_REPORT_READ_ONLY_REQUIRED']);

/** Dedicated connection + read-only repeatable snapshot, always rolled back. Never reuse an application transaction. */
export async function readLegacyDeliveryReport(url: string, options: LegacyReportOptions, ssl?: pg.ClientConfig['ssl']): Promise<LegacyDeliveryReport> {
  const limit=options.limit ?? 100;
  if (!UUID.test(options.tenantId) || !Number.isInteger(limit) || limit<1 || limit>500 ||
      (options.afterMessageId !== undefined && !UUID.test(options.afterMessageId))) throw new Error('LEGACY_REPORT_INVALID_SCOPE');
  let c:pg.Client | undefined;
  let begun=false;
  try {
    c=new pg.Client({connectionString:url,ssl,application_name:'realty-legacy-delivery-report',connectionTimeoutMillis:10_000});
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    begun=true;
    await c.query("SET LOCAL statement_timeout='15s'");
    const attrs=(await c.query<{allowed:boolean;read_only:string}>(`SELECT rolsuper OR rolbypassrls AS allowed,
      current_setting('transaction_read_only') AS read_only FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!attrs?.allowed) throw new Error('LEGACY_REPORT_OPERATOR_ROLE_REQUIRED');
    if (attrs.read_only!=='on') throw new Error('LEGACY_REPORT_READ_ONLY_REQUIRED');
    if (!(await c.query('SELECT id FROM public.tenants WHERE id=$1::uuid',[options.tenantId])).rowCount) throw new Error('LEGACY_REPORT_TENANT_NOT_FOUND');
    // Matches migration 0102's candidate/dependency predicate; tests compare actual preflight behavior.
    // Every association includes tenant_id even for UUIDs that collide across tenants.
    const row=(await c.query<{snapshot_at:Date;total:number;blocked:number;messages:LegacyDeliveryReport['messages']}>(`
      WITH candidates AS MATERIALIZED (
        SELECT id,tenant_id,assistant_action_id FROM public.messages
         WHERE tenant_id=$1::uuid AND status='failed' AND status_reason='DISPATCH_UNKNOWN_UNRESOLVED'
           AND provider_message_ref IS NULL AND provider_error_code IS NULL
      ), classified AS MATERIALIZED (
        SELECT m.id,COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',d.kind,'id',d.id,'status',d.status) ORDER BY d.kind,d.id)
          FROM (
            SELECT 'assistant_action' AS kind,a.id,a.status FROM public.assistant_actions a
             WHERE a.tenant_id=m.tenant_id AND a.id=m.assistant_action_id AND a.status='blocked'
            UNION ALL SELECT 'shared_fact',f.id,f.status FROM public.ai_isa_shared_facts f
             WHERE f.tenant_id=m.tenant_id AND f.message_id=m.id AND f.status='canceled'
            UNION ALL SELECT 'turn',t.id,t.status FROM public.ai_isa_turns t
             WHERE t.tenant_id=m.tenant_id AND t.message_id=m.id AND t.status IN ('blocked','canceled','canceled_paused')
            UNION ALL SELECT 'handoff',h.id,h.confirmation_status FROM public.ai_isa_handoffs h
             WHERE h.tenant_id=m.tenant_id AND h.pending_message_id=m.id AND h.confirmation_status IN ('refused','canceled')
          ) d),'[]'::jsonb) AS dependencies FROM candidates m
      ), page AS (SELECT * FROM classified WHERE ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3)
      SELECT transaction_timestamp() AS snapshot_at,
        (SELECT count(*)::integer FROM classified) AS total,
        (SELECT count(*)::integer FROM classified WHERE jsonb_array_length(dependencies)>0) AS blocked,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('messageId',id,'dependencies',dependencies) ORDER BY id) FROM page),'[]'::jsonb) AS messages
    `,[options.tenantId,options.afterMessageId ?? null,limit+1])).rows[0]!;
    const truncated=row.messages.length>limit;
    const messages=row.messages.slice(0,limit);
    return {version:1,tenantId:options.tenantId.toLowerCase(),snapshotAt:row.snapshot_at.toISOString(),readOnly:true,releaseReady:false,drainVerified:false,
      scope:'failed_unresolved_without_provider_evidence',pageAfterMessageId:options.afterMessageId?.toLowerCase() ?? null,pageLimit:limit,totalCandidates:row.total,totalBlockedMessages:row.blocked,messages,truncated,
      nextAfterMessageId:truncated?messages.at(-1)!.messageId:null};
  } catch (error) {
    // Do not surface server text, connection URLs, hostnames, row content or credentials.
    if (error instanceof Error && SAFE_ERRORS.has(error.message)) throw error;
    // eslint-disable-next-line preserve-caught-error -- Raw database causes can contain credentials or row contents.
    throw new Error('LEGACY_REPORT_QUERY_FAILED');
  } finally {
    if (c && begun) await c.query('ROLLBACK').catch(()=>{});
    if (c) await c.end().catch(()=>{});
  }
}

/** Exit 2 means blocked or incomplete; even exit 0 is never a release approval. */
export async function runLegacyDeliveryReport(argv: readonly string[], io: {url?:string;ssl?:pg.ClientConfig['ssl'];out:(line:string)=>void}): Promise<number> {
  const args=argv.filter(a=>a!=='--');
  const values=new Map<string,string>();
  for (let i=0;i<args.length;i+=2) {
    const key=args[i]!, value=args[i+1];
    if (!['--tenant','--limit','--after'].includes(key) || value===undefined || values.has(key)) {io.out('LEGACY_REPORT_INVALID_ARGUMENTS');return 1;}
    values.set(key,value);
  }
  const tenantId=values.get('--tenant');
  if (!tenantId || !io.url) {io.out('LEGACY_REPORT_EXPLICIT_TENANT_AND_MIGRATION_URL_REQUIRED');return 1;}
  try {
    const report=await readLegacyDeliveryReport(io.url,{tenantId,limit:values.has('--limit')?Number(values.get('--limit')):undefined,afterMessageId:values.get('--after')},io.ssl);
    io.out(JSON.stringify(report));
    return report.totalBlockedMessages>0 || report.truncated ? 2 : 0;
  } catch (error) {
    io.out(error instanceof Error && SAFE_ERRORS.has(error.message)?error.message:'LEGACY_REPORT_QUERY_FAILED');
    return 1;
  }
}
