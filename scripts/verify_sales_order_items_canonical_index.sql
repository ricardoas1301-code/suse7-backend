-- Verificação catálogo + smoke estrutural ON CONFLICT target (read-only exceto rollback implícito)
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  pg_get_indexdef(ix.indexrelid) AS indexdef
FROM pg_class t
JOIN pg_index ix ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE t.relname = 'sales_order_items'
  AND i.relname = 'sales_order_items_marketplace_order_line_uidx';

SELECT
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      WHERE t.relname = 'sales_order_items'
        AND i.relname = 'sales_order_items_marketplace_order_line_uidx'
        AND ix.indisunique = true
        AND pg_get_indexdef(ix.indexrelid) NOT ILIKE '%WHERE%'
    ) THEN 'INDEX_OK'
    ELSE 'INDEX_MISSING_OR_PARTIAL'
  END AS smoke_status;
