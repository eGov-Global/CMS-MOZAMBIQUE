# Tenant data for `mz` used by upgrade.sh step 5 (lib/fix_access.py)

- `search-scope.json` — `resource` merged into the `/pgr-services/v2/request/_search`
  action (both ACCESSCONTROL action masters). Replaces the old env-based
  `PGR_DEPARTMENT_SCOPE_ROLES=CMS_SUPERVISOR,CMS_CASE_MANAGER,CMS_RECEPTION_OFFICER`
  with the same behaviour: those roles see their own department, everyone else is
  open. Add roles here (OWN/ALL per axis); see docs/2.12/jurisdiction-access-control.md.
- `inbox-visibility.json` — `RAINMAKER-PGR.InboxVisibilityConfig` (My/All inbox tabs,
  V1 = "My" is the assignee). Needs PGR_VISIBILITY_ENABLED=true on pgr-services.
