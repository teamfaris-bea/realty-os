// R-GATE-2: only apps/api/src/comms/dispatch.ts and dial.ts may reach a provider's outbound
// send/dial capability (they gate with canContact at send time). Everyone else must go through
// dispatchOutbound()/dialOutbound().
//
// Reported anywhere outside the allowlist (configured in eslint.config.js):
//   - any reference to a reserved outbound method name: `x.sendSms`, `x.sendEmail`, `x.dialCall`,
//     `x.deliverChannelMessage` (module 22: the web-chat transport, R-GATE-15; only comms/dispatch.ts),
//     `x.publishPost` / `x.postReviewReply` (module 29: publishing, R-GATE-15, R-MKT-12; only marketing/publish.ts)
//     `x.applyBudgetChange` / `x.pauseCampaign` (module 52: Google Ads budgets and pauses, R-GATE-15, R-ADS-3; only
//     ads/dispatch.ts, besides the adapter itself in ads/provider.ts)
//     (calls, references passed as callbacks, destructuring `const { sendSms } = ...`)
//   - a `send` / `dial` member on a provider object, e.g. `providers.telephony.send(...)`,
//     `telephony.dial(...)` (Fastify's `reply.send()` is not affected)

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

const DEFAULT_RESERVED = ['sendSms', 'sendEmail', 'dialCall', 'deliverChannelMessage', 'publishPost', 'postReviewReply', 'applyBudgetChange', 'pauseCampaign'];
const DEFAULT_PROVIDER_IDS = ['providers', 'telephony', 'email', 'telephonyProvider', 'emailProvider'];

/**
 * @param {any} node
 * @returns {string[]}
 */
function chainIdentifiers(node) {
  /** @type {string[]} */
  const out = [];
  let cur = node;
  while (cur) {
    if (cur.type === 'MemberExpression') {
      if (!cur.computed && cur.property.type === 'Identifier') out.push(cur.property.name);
      cur = cur.object;
    } else if (cur.type === 'ChainExpression' || cur.type === 'TSNonNullExpression') {
      cur = cur.expression;
    } else if (cur.type === 'Identifier') {
      out.push(cur.name);
      break;
    } else if (cur.type === 'ThisExpression') {
      break;
    } else {
      break;
    }
  }
  return out;
}

/**
 * @param {any} prop
 * @returns {string | null}
 */
function propertyName(prop) {
  if (!prop) return null;
  if (prop.type === 'Identifier') return prop.name;
  if (prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
  return null;
}

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Only comms/dispatch.ts and comms/dial.ts may use provider send/dial (R-GATE-2)' },
    schema: [
      {
        type: 'object',
        properties: {
          reserved: { type: 'array', items: { type: 'string' } },
          providerIdentifiers: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outbound:
        'Provider outbound "{{name}}" may only be used in apps/api/src/comms/dispatch.ts or dial.ts. ' +
        'Queue a message and call dispatchOutbound()/dialOutbound() so canContact runs at send time (R-GATE-2).',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const reserved = new Set(opts.reserved ?? DEFAULT_RESERVED);
    const providerIds = new Set(opts.providerIdentifiers ?? DEFAULT_PROVIDER_IDS);
    return {
      /** @param {any} node */
      MemberExpression(node) {
        const name = node.computed
          ? node.property.type === 'Literal' && typeof node.property.value === 'string'
            ? node.property.value
            : null
          : propertyName(node.property);
        if (!name) return;
        if (reserved.has(name)) {
          context.report({ node, messageId: 'outbound', data: { name } });
          return;
        }
        if (name === 'send' || name === 'dial') {
          const ids = chainIdentifiers(node.object);
          if (ids.some((id) => providerIds.has(id))) context.report({ node, messageId: 'outbound', data: { name } });
        }
      },
      /** @param {any} node */
      Property(node) {
        // destructuring: const { sendSms } = providers.telephony
        if (node.parent?.type !== 'ObjectPattern') return;
        const name = propertyName(node.key);
        if (name && reserved.has(name)) context.report({ node, messageId: 'outbound', data: { name } });
      },
    };
  },
};

export default rule;
