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

from flask import Blueprint, Response, render_template_string, url_for

docs = Blueprint("docs", __name__)

SPEC_PATH = Path(__file__).with_name("openapi.yaml")
DEFAULT_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5"

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
    return Response(SPEC_PATH.read_text(encoding="utf-8"), mimetype="application/yaml")
