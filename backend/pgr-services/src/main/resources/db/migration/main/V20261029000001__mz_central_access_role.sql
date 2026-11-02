-- mz: the central department (IGE) sees complaints of every department.
-- Complaint scope is authored per role on the search action (2008, ACCESSCONTROL-ACTIONS
-- and its -TEST twin), and the most open role a caller holds wins. IGE staff hold the
-- same functional roles as everyone else (department OWN), so a separate role grants
-- them ALL: CMS_CENTRAL_ACCESS. This covers the inbox, search and the dashboard, which
-- all resolve the same policy.
-- The role is given to people through HRMS, not here. Every statement is tenant mz only
-- and safe to re-run; on a fresh install where MDMS isn't seeded yet it changes nothing.
-- Existing rows are matched on their data, not uniqueidentifier: access-control rows
-- are keyed either by their dotted x-unique values or by a sha256 hash (seeds carry both).

-- 1. The role.
INSERT INTO eg_mdms_data (id, tenantid, uniqueidentifier, schemacode, data, isactive,
                          createdby, lastmodifiedby, createdtime, lastmodifiedtime)
SELECT gen_random_uuid()::text, 'mz', 'CMS_CENTRAL_ACCESS', 'ACCESSCONTROL-ROLES.roles',
       '{"code": "CMS_CENTRAL_ACCESS", "name": "CMS Central Access", "description": "Sees complaints of all departments (central department staff)"}'::jsonb,
       true, 'pgr-services-migration', 'pgr-services-migration',
       (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE EXISTS (SELECT 1 FROM eg_mdms_data WHERE tenantid = 'mz' AND schemacode = 'ACCESSCONTROL-ROLES.roles')
  AND NOT EXISTS (SELECT 1 FROM eg_mdms_data WHERE tenantid = 'mz' AND schemacode = 'ACCESSCONTROL-ROLES.roles'
                                               AND data->>'code' = 'CMS_CENTRAL_ACCESS')
ON CONFLICT (tenantid, schemacode, uniqueidentifier) DO NOTHING;

-- 2. Map it to the search action, so the role-scoped policy lookup returns action 2008
--    for it like it does for the functional roles.
INSERT INTO eg_mdms_data (id, tenantid, uniqueidentifier, schemacode, data, isactive,
                          createdby, lastmodifiedby, createdtime, lastmodifiedtime)
SELECT gen_random_uuid()::text, 'mz', 'CMS_CENTRAL_ACCESS.2008', 'ACCESSCONTROL-ROLEACTIONS.roleactions',
       jsonb_build_object('id', nxt.id, 'actionid', 2008, 'rolecode', 'CMS_CENTRAL_ACCESS',
                          'tenantId', 'mz', 'actioncode', ''),
       true, 'pgr-services-migration', 'pgr-services-migration',
       (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM (
  SELECT coalesce(max((data->>'id')::bigint), 0) + 1 AS id
  FROM eg_mdms_data
  WHERE schemacode = 'ACCESSCONTROL-ROLEACTIONS.roleactions'
    AND data->>'id' ~ '^[0-9]+$'
) nxt
WHERE EXISTS (SELECT 1 FROM eg_mdms_data WHERE tenantid = 'mz' AND schemacode = 'ACCESSCONTROL-ROLEACTIONS.roleactions'
                                          AND data->>'rolecode' = 'CMS_SUPERVISOR' AND data->>'actionid' = '2008')
  AND NOT EXISTS (SELECT 1 FROM eg_mdms_data WHERE tenantid = 'mz' AND schemacode = 'ACCESSCONTROL-ROLEACTIONS.roleactions'
                                               AND data->>'rolecode' = 'CMS_CENTRAL_ACCESS' AND data->>'actionid' = '2008')
ON CONFLICT (tenantid, schemacode, uniqueidentifier) DO NOTHING;

-- 3. Grant ALL on both axes in the search action's scope policy.
UPDATE eg_mdms_data
SET data = jsonb_set(data, '{resource,complaint,scope,roleScopes,CMS_CENTRAL_ACCESS}',
                     '{"department": "ALL", "jurisdiction": "ALL"}'::jsonb),
    lastmodifiedby = 'pgr-services-migration',
    lastmodifiedtime = (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
WHERE tenantid = 'mz'
  AND schemacode IN ('ACCESSCONTROL-ACTIONS.actions', 'ACCESSCONTROL-ACTIONS-TEST.actions-test')
  AND data->>'url' = '/pgr-services/v2/request/_search'
  AND jsonb_typeof(data->'resource'->'complaint'->'scope'->'roleScopes') = 'object'
  AND data->'resource'->'complaint'->'scope'->'roleScopes'->'CMS_CENTRAL_ACCESS'
      IS DISTINCT FROM '{"department": "ALL", "jurisdiction": "ALL"}'::jsonb;
