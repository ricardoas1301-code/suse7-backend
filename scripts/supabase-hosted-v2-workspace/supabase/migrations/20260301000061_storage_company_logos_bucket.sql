-- ======================================================================
-- Storage: bucket público para logos de seller_companies (Perfil > Empresa)
-- Path esperado no cliente: {auth.uid()}/{seller_company_id ou draft}/{timestamp}-{filename}
-- ======================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-logos',
  'company-logos',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Leitura pública (bucket público — URLs estáveis em <img>)
DROP POLICY IF EXISTS "company_logos_select_public" ON storage.objects;
CREATE POLICY "company_logos_select_public"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'company-logos');

DROP POLICY IF EXISTS "company_logos_insert_own" ON storage.objects;
CREATE POLICY "company_logos_insert_own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND split_part(name, '/', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS "company_logos_update_own" ON storage.objects;
CREATE POLICY "company_logos_update_own"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND split_part(name, '/', 1) = auth.uid()::text
  );

DROP POLICY IF EXISTS "company_logos_delete_own" ON storage.objects;
CREATE POLICY "company_logos_delete_own"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND split_part(name, '/', 1) = auth.uid()::text
  );
