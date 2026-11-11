// api/lists public interface (PARITY_PLAN §4.2): resolveSelection for module 63 (bulk), and the tag
// and custom-field writers for module 65 (import) and 63 (bulk tag/untag). Other modules import only
// from here.
export { resolveSelection, DEFAULT_SELECTION_CAP, type Selection, type SelectionOptions } from './selection.js';
export {
  ensureTags,
  addContactTags,
  removeContactTags,
  ensureFieldDef,
  setFieldValue,
  type EnsureTagsResult,
  type EnsuredTag,
  type EnsureFieldResult,
  type SetValueResult,
  type TagLinkBy,
  type TagWriter,
  type ValueBy,
} from './writers.js';
export { listsRoutes } from './routes.js';
