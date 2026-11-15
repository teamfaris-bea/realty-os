-- Keep the internal source-capture path subject to the same support read-only
-- backstop as every other public table. Existing migration checksums stay intact.
CREATE TRIGGER support_read_only
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.contact_import_sources
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
