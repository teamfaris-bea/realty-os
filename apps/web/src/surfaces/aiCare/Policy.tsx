// The playbooks pages (list and detail) show nothing of an ai_isa playbook but this pointer (Q5: editing and approving
// the team policy in the app is not built; the read-only view is on the team's AI assistant page).
import { Link } from 'react-router-dom';
import { useAdmin } from './api.js';

export const isAiIsaPlaybook = (p: { kind?: string | null }) => p.kind === 'ai_isa';

export function AiPolicyNotice() {
  return (
    <p className="text-[15px] text-ink" data-testid="ai-policy-notice">
      The AI assistant policy is under{' '}
      <Link to="/settings/ai-assistant/team" className="font-medium text-accent underline">
        Settings, AI assistant (ISA)
      </Link>
      .
    </p>
  );
}

/** CompliancePage: the AI ISA's own notice, from GET /admin/ai-isa (omitted on any error or for a role without it). */
export function AiIsaComplianceNotice() {
  const q = useAdmin();
  if (!q.data) return null;
  return (
    <p className="text-[15px] text-ink" data-testid="ai-isa-notice">
      {q.data.noticeSentence}
    </p>
  );
}
