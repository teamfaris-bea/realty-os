// @realty/eslint-plugin: architecture rules (docs/BUILD_PLAN.md ground rules; wired in /eslint.config.js).
import noPredictionImport from './rules/no-prediction-import.js';
import noProviderOutbound from './rules/no-provider-outbound.js';
import noRelativeOutsidePackage from './rules/no-relative-outside-package.js';
import noSessionGuc from './rules/no-session-guc.js';
import noSystemActor from './rules/no-system-actor.js';
import portalTxSeparation from './rules/portal-tx-separation.js';

const plugin = {
  meta: { name: '@realty/eslint-plugin', version: '0.0.0' },
  rules: {
    'no-prediction-import': noPredictionImport,
    'no-provider-outbound': noProviderOutbound,
    'no-relative-outside-package': noRelativeOutsidePackage,
    'no-session-guc': noSessionGuc,
    'no-system-actor': noSystemActor,
    'portal-tx-separation': portalTxSeparation,
  },
};

export default plugin;
