# Owner review of imported sources

Imports retain their full raw source label. Review Sources appears before stage/tag/custom-field mapping in the import preview. The Owner may confirm an exact imported label against a source through the existing reauthenticated mapping endpoint. Suggestions, including the existing trim/lowercase whole-name helper, never apply a mapping automatically. No fuzzy matches, aliases, substring rules or Unicode normalization are used for classification.

An imported contact (including an existing contact matched by an import and any merged record) is unclassified when any imported label is missing or does not have exactly one current Owner-confirmed mapping. Automation is blocked. New manual contacts without import evidence are unaffected. The API returns `classification: SOURCE_UNCLASSIFIED` and `noAutomatedContact: true` on unclassified review rows. Missing labels are visible under the empty review key and cannot be mapped as a shared empty-label cohort.

`SOURCE_UNCLASSIFIED` is distinct from a proven source prohibition, which takes precedence as `SOURCE_NO_AUTOMATED_CONTACT`. Enrollment, first-response, bulk and dispatch paths expose the distinct code. Existing boolean consumers (including AI-care chain checks) also block unclassified imports; some retain their established source-prohibition reason vocabulary. All existing consent, opt-out, no-AI and dispatch gates still apply after classification. Mapping does not start or resume a plan or restore a withdrawn draft.

`contact_import_sources` retains proven associations separately from the current mapping. Unmapping, moving a label, or changing its spelling cannot erase a previously established source prohibition. A source's explicit Owner-controlled restriction setting remains authoritative; a label change is not a way to switch it off. The retained association is per person/source, not a rule affecting every future person carrying an old label. Existing raw import records are not rewritten by this migration.

Unmapping stops affected active and paused plans and withdraws proposed plan/trigger drafts in the same transaction, including closing draft feed cards and canceling queued/scheduled plan-step messages. Classification is evaluated retrospectively from retained import evidence; migration 0101 captures existing mapped associations and stops existing unclassified imports. No hidden cloud migration was used.

Long labels are no longer truncated by JavaScript or PostgreSQL for classification or review. Exact full labels distinguish suffixes and supplementary-plane characters. Legacy truncated provenance remains conservative evidence for restrictions through the existing source predicate, but never establishes permissive classification for a different full raw label. Where the full import record survives it is preferred over the old truncated display label.

Policy questions deliberately left fail closed:

- Missing source evidence has no invented meaning or default source. It stays blocked; there is no new bulk override for missing labels.
- Multiple mappings are ambiguous and blocked, including mappings inserted outside the API. The Owner API serializes changes and moves a label to one source.
- Correcting a wrongly established historical source association has no new removal endpoint. An explicit Owner-policy decision is needed before such a release workflow is added.
- A provider request already sent or in flight cannot be withdrawn by a database change. The existing dispatch transaction/provider-send gap is not closed by this change.
