"""Serves the OpenAPI spec and a Swagger UI that can call this deployment.

Unauthenticated on purpose: the docs describe the contract, they do not expose data.
Every operation in them still needs the X-Adapter-Key header, which the reader enters
through Swagger UI's Authorize button.

The UI is loaded from a CDN rather than vendored, so there is nothing to build and no
extra Python dependency. Set SWAGGER_UI_URL to a self-hosted copy for an air-gapped
deployment.
"""

import os
from pathlib import Path

from flask import Blueprint, Response, render_template_string, request, url_for

docs = Blueprint("docs", __name__)

SPEC_PATH = Path(__file__).with_name("openapi.yaml")
DEFAULT_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5"

# The one line in the spec that has to change per deployment.
SERVERS_ROOT_LINE = "  - url: /\n"

PAGE = """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Citizen Portal Adapter — API</title>
    <link rel="stylesheet" href="{{ ui }}/swagger-ui.css">
  </head>
  <body>
    <div id="swagger"></div>
    <script src="{{ ui }}/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({
        url: "{{ spec_url }}",        // url_for, so a path prefix is honoured
        dom_id: "#swagger",
        deepLinking: true,
        persistAuthorization: true,   // the key survives a page reload
        tryItOutEnabled: true,
        displayRequestDuration: true
      });
    </script>
  </body>
</html>
"""


@docs.get("/docs")
def swagger_ui():
    return render_template_string(
        PAGE,
        ui=os.getenv("SWAGGER_UI_URL", DEFAULT_UI),
        spec_url=url_for("docs.openapi_yaml"),
    )


@docs.get("/docs/openapi.yaml")
def openapi_yaml():
    return Response(_spec_served_under(request.script_root), mimetype="application/yaml")


def _spec_served_under(root):
    """Point `servers` at the path this deployment is actually reached on.

    Swagger UI resolves every operation against servers[0].url, which is static in
    the file. Behind a path prefix that has to become '/adapter', or Try-it-out
    calls '/master-data/departments' on the bare host and hits whatever else lives
    there. `request.script_root` is the prefix, and is empty when there is none.
    """
    spec = SPEC_PATH.read_text(encoding="utf-8")
    if not root:
        return spec
    return spec.replace(SERVERS_ROOT_LINE, "  - url: {}\n".format(root), 1)
