/**
 * Approved read-only statements used by the live qualification session.
 *
 * These are sent to the Oracle driver without a trailing semicolon. The same
 * text is written to the plan so the approval hash covers the exact queries.
 */
export const BACKUP_SQL = `SELECT type, name, line, text
  FROM user_source
 WHERE type IN ('PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE')
 ORDER BY type, name, line`;

export const BASELINE_SQL = `SELECT object_type, object_name, status
  FROM user_objects
 WHERE status <> 'VALID'
 ORDER BY object_type, object_name`;

export const IDENTIFIERS_SQL = `SELECT object_name, object_type, name, signature, type, usage, usage_id, line, col, usage_context_id
  FROM user_identifiers
 WHERE object_type IN ('PACKAGE', 'PACKAGE BODY', 'FUNCTION')
 ORDER BY object_type, object_name, line, col, usage_id`;

export const DEPENDENCIES_SQL = `SELECT name, type, referenced_owner, referenced_name, referenced_type, dependency_type
  FROM user_dependencies
 WHERE type IN ('PACKAGE', 'PACKAGE BODY', 'FUNCTION')
 ORDER BY type, name, referenced_owner, referenced_name, referenced_type`;
