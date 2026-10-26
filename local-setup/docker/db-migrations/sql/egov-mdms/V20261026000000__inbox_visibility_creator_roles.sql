-- Add the optional creatorRoles list to RAINMAKER-PGR.InboxVisibilityConfig.
--
-- The server-side inbox (pgr-services VisibilityService) reads creatorRoles: for
-- a user holding one of these roles, My Complaints lists the complaints they
-- created as well as those assigned to them. The schema is
-- additionalProperties:false, so on a tenant whose schema predates the field,
-- saving creatorRoles fails validation with a 400.
--
-- mdms-v2 can't update a schema over the API (schema/v1/_update -> HTTP 501),
-- so the property is added at the DB level, for every tenant's
-- InboxVisibilityConfig schema. No data rows change: the field is optional, and
-- a record without it keeps My Complaints as "assigned to me".
--
-- The property embedded below MUST stay identical to creatorRoles in
-- utilities/default-data-handler/src/main/resources/schema/RAINMAKER-PGR.json.
-- When you change one, change the other.
--
-- Idempotent and guarded: a definition that already has creatorRoles is left
-- alone, so a fresh box and a re-run are both no-ops.

BEGIN;

UPDATE eg_mdms_schema_definition
   SET definition = jsonb_set(
         definition,
         '{properties,creatorRoles}',
         $prop${"type": "array", "items": {"type": "string"}, "description": "Roles whose My Complaints tab lists the complaints they created as well as those assigned to them (server-side resolver)."}$prop$::jsonb,
         true
       ),
       lastmodifiedby = 'egov-mdms-migration',
       lastmodifiedtime = (extract(epoch from now()) * 1000)::bigint
 WHERE code = 'RAINMAKER-PGR.InboxVisibilityConfig'
   AND jsonb_typeof(definition -> 'properties') = 'object'
   AND NOT (definition -> 'properties' ? 'creatorRoles');

COMMIT;
