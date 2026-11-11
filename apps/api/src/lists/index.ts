// api/lists public interface (PARITY_PLAN §4.2): resolveSelection, and selectionAudience (the R-PAR-8 rule
// of a list people were picked from), for module 63 (bulk); the tag and custom-field writers for module 65
// (import) and 63 (bulk tag/untag). Other modules import only from here.
export { resolveSelection, selectionAudience, DEFAULT_SELECTION_CAP, type Selection, type SelectionOptions } from './selection.js';
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
