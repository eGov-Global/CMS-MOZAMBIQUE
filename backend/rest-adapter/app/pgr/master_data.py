"""Serves the lists the portal needs to build its forms.

Complaint types and localities are trees of unknown depth, so both are exposed as a
*walk*: the portal asks for one level, the citizen picks, and the chosen codes come
back as the path for the next request. That is the same traversal the WhatsApp
chatbot performs, so both channels stay consistent with the deployment's data.
"""

import requests

from app.domain.errors import PgrRequestFailed
from app.domain.models import Option, WalkStep

MDMS_PATH = "egov-mdms-service/v1/_search"
BOUNDARY_DEFINITION_PATH = "boundary-service/boundary-hierarchy-definition/_search"
BOUNDARY_RELATIONSHIP_PATH = "boundary-service/boundary-relationships/_search"
LOCALISATION_PATH = "localization/messages/v1/_search"

PGR_MODULE = "RAINMAKER-PGR"
HIERARCHY_MASTER = "ComplaintHierarchy"
HIERARCHY_DEFINITION_MASTER = "ComplaintHierarchyDefinition"
COMMON_MASTERS_MODULE = "common-masters"
DEPARTMENT_MASTER = "Department"

ACTIVE_ONLY = "$.[?(@.active == true)]"
HIERARCHY_LABEL_PREFIX = "COMPLAINT_HIERARCHY."
JSON_HEADERS = {"Content-Type": "application/json"}


class MasterDataService:
    def __init__(self, digit_host, city_tenant_id, root_tenant_id, labels, timeout_seconds,
                 locality_hierarchy_type=""):
        self._digit_host = digit_host
        self._city_tenant_id = city_tenant_id
        self._root_tenant_id = root_tenant_id
        self._labels = labels
        self._timeout_seconds = timeout_seconds
        self._locality_hierarchy_type = locality_hierarchy_type

    def departments(self, locale) -> list:
        rows = self._mdms(COMMON_MASTERS_MODULE, DEPARTMENT_MASTER)
        translate = self._labels.translator(locale)
        return [Option(code=row["code"], name=translate(row["code"], row.get("name"))) for row in rows]

    def complaint_types(self, path, locale) -> WalkStep:
        levels = self._hierarchy_levels()
        rows = self._mdms(PGR_MODULE, HIERARCHY_MASTER)
        children = _children_of(rows, path, _hierarchy_type(levels))
        level = _level_for(levels, children, path)
        translate = self._labels.translator(locale)

        return WalkStep(
            level=level.get("label", ""),
            options=[
                Option(code=row["code"], name=translate(HIERARCHY_LABEL_PREFIX + row["code"].upper(), row["code"]))
                for row in children
            ],
            is_leaf=level.get("isLeafServiceCode") is True,
            path=path,
        )

    def localities(self, path, locale) -> WalkStep:
        hierarchy_type = self._locality_hierarchy_type or self._boundary_hierarchy_type()
        if not hierarchy_type:
            return WalkStep(level="", options=[], is_leaf=True, path=path)

        nodes = _descend(self._boundary_roots(hierarchy_type), path)
        translate = self._labels.translator(locale)
        # DIGIT registers boundary labels as {TENANT}_{hierarchyType}_{code}, the
        # code kept in its original case - unlike the complaint hierarchy's labels,
        # this isn't a plain uppercased code.
        label_prefix = f"{self._city_tenant_id.upper()}_{hierarchy_type}_"

        return WalkStep(
            level=nodes[0].get("boundaryType", "") if nodes else "",
            options=sorted(
                (Option(code=node["code"], name=translate(label_prefix + node["code"], node["code"])) for node in nodes),
                key=lambda option: option.name,
            ),
            is_leaf=all(not node.get("children") for node in nodes),
            path=path,
        )

    def _hierarchy_levels(self) -> list:
        rows = self._mdms(PGR_MODULE, HIERARCHY_DEFINITION_MASTER)
        definition = rows[0] if rows else {}
        levels = definition.get("levels") or []
        for level in levels:
            level.setdefault("hierarchyType", definition.get("hierarchyType"))
        return sorted(levels, key=lambda level: level.get("order", 0))

    def _mdms(self, module_name, master_name) -> list:
        body = {
            "RequestInfo": {"apiId": "Rainmaker"},
            "MdmsCriteria": {
                "tenantId": self._root_tenant_id,
                "moduleDetails": [
                    {
                        "moduleName": module_name,
                        "masterDetails": [{"name": master_name, "filter": ACTIVE_ONLY}],
                    }
                ],
            },
        }
        response = self._post(MDMS_PATH, {"tenantId": self._root_tenant_id}, body)
        return (response.get("MdmsRes") or {}).get(module_name, {}).get(master_name) or []

    def _boundary_hierarchy_type(self):
        body = {"RequestInfo": {}, "BoundaryTypeHierarchySearchCriteria": {"tenantId": self._city_tenant_id}}
        response = self._post(BOUNDARY_DEFINITION_PATH, {}, body)
        definitions = response.get("BoundaryHierarchy") or []
        return definitions[0].get("hierarchyType") if definitions else None

    def _boundary_roots(self, hierarchy_type) -> list:
        query = {
            "tenantId": self._city_tenant_id,
            "hierarchyType": hierarchy_type,
            "includeChildren": "true",
        }
        response = self._post(BOUNDARY_RELATIONSHIP_PATH, query, {"RequestInfo": {}})
        return [node for entry in (response.get("TenantBoundary") or []) for node in (entry.get("boundary") or [])]

    def _post(self, path, query, body) -> dict:
        try:
            response = requests.post(
                self._digit_host + path,
                params=query,
                json=body,
                headers=JSON_HEADERS,
                timeout=self._timeout_seconds,
            )
        except requests.RequestException as error:
            raise PgrRequestFailed(f"Could not reach master data: {error}")

        if response.status_code != 200:
            raise PgrRequestFailed(
                f"Master data request to {path} failed",
                details={"status": response.status_code},
            )
        return response.json()

    def district_for(self, locality_code):
        """The district ancestor of any locality code, per the active boundary hierarchy."""
        hierarchy_type = self._locality_hierarchy_type or self._boundary_hierarchy_type()
        if not hierarchy_type:
            return None
        path = _path_to(self._boundary_roots(hierarchy_type), locality_code)
        return path[1] if len(path) > 1 else None



def _hierarchy_type(levels):
    return levels[0].get("hierarchyType") if levels else None


def _children_of(rows, path, hierarchy_type) -> list:
    parent_code = path[-1] if path else None
    matching = [
        row
        for row in rows
        if (not hierarchy_type or row.get("hierarchyType") == hierarchy_type)
        and row.get("parentCode") == parent_code
    ]
    return sorted(matching, key=lambda row: (_is_other(row), row.get("order", 0), str(row.get("code"))))


def _level_for(levels, children, path) -> dict:
    """The level the children sit on; fall back to depth when they declare none."""
    child_level_code = children[0].get("levelCode") if children else None
    for level in levels:
        if level.get("levelCode") == child_level_code:
            return level
    return levels[len(path)] if len(path) < len(levels) else {}


def _descend(nodes, path) -> list:
    for code in path:
        match = next((node for node in nodes if node.get("code") == code), None)
        nodes = (match or {}).get("children") or []
    return nodes


def _is_other(row) -> bool:
    """'Other' options sort last, wherever the deployment placed them."""
    return str(row.get("name", "")).strip().lower() in {"other", "others", "outro", "outros"}

def _path_to(nodes, code, trail=()) -> tuple:
    """Codes from the root down to `code`, inclusive - or () if not found."""
    for node in nodes:
        node_code = node.get("code")
        if node_code == code:
            return trail + (node_code,)
        found = _path_to(node.get("children") or [], code, trail + (node_code,))
        if found:
            return found
    return ()
