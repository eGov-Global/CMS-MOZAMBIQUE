"""Application factory: builds the object graph once, wires it into Flask."""

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from app.api.errors import register_error_handlers
from app.api.docs import docs
from app.api.routes import api
from app.config import load_config
from app.domain.phone import PhoneNumbers
from app.pgr.citizen_lookup import CitizenLookup
from app.pgr.client import PgrClient
from app.pgr.labels import LabelService
from app.pgr.master_data import MasterDataService
from app.pgr.reception_officer import ReceptionOfficerSession
from app.pgr.filestore import FileStoreClient
from app.logging_config import configure_logging


def create_app(config=None) -> Flask:
    config = config or load_config()
    configure_logging(config)

    app = Flask(__name__)
    app.config["ADAPTER"] = config
    app.config["PGR_CLIENT"] = _build_pgr_client(config)
    app.config["MASTER_DATA"] = _build_master_data(config)
    app.config["PHONES"] = PhoneNumbers(config.country_code, config.mobile_number_length)
    app.config["FILE_STORE"] = _build_file_store(config)


    _trust_proxy(app, config.proxy_hops)
    app.register_blueprint(api)
    app.register_blueprint(docs)
    register_error_handlers(app)
    return app


def _trust_proxy(app, hops):
    """Honour X-Forwarded-* when a reverse proxy sits in front.

    Only X-Forwarded-Prefix actually matters here: served under a path prefix, it is
    what makes url_for emit '/adapter/docs/openapi.yaml' rather than
    '/docs/openapi.yaml', which is the difference between Swagger UI loading and not.

    Off by default. These headers are client-supplied and must only be trusted when
    something upstream sets them, so the number of proxy hops is explicit.
    """
    if hops:
        app.wsgi_app = ProxyFix(
            app.wsgi_app, x_for=hops, x_proto=hops, x_host=hops, x_prefix=hops
        )


def _build_pgr_client(config) -> PgrClient:
    session = ReceptionOfficerSession(
        credentials=config.officer,
        user_service_host=config.user_service_host,
        token_ttl_seconds=config.token_ttl_seconds,
        timeout_seconds=config.request_timeout_seconds,
    )
    citizens = CitizenLookup(
        user_service_host=config.user_service_host,
        root_tenant_id=config.officer.tenant_id,
        timeout_seconds=config.request_timeout_seconds,
    )
    return PgrClient(
        digit_host=config.digit_host,
        city_tenant_id=config.city_tenant_id,
        search_tenant_id=config.search_tenant_id,
        defaults=config.defaults,
        session=session,
        citizens=citizens,
        extra_filers=config.extra_filers,
        timeout_seconds=config.request_timeout_seconds,
    )


def _build_master_data(config) -> MasterDataService:
    labels = LabelService(
        digit_host=config.digit_host,
        root_tenant_id=config.master_data.root_tenant_id,
        modules=config.master_data.localisation_modules,
        default_locale=config.master_data.default_locale,
        timeout_seconds=config.request_timeout_seconds,
    )
    return MasterDataService(
        digit_host=config.digit_host,
        city_tenant_id=config.city_tenant_id,
        root_tenant_id=config.master_data.root_tenant_id,
        labels=labels,
        timeout_seconds=config.request_timeout_seconds,
    )

def _build_file_store(config) -> FileStoreClient:
    return FileStoreClient(
        digit_host=config.digit_host,
        tenant_id=config.city_tenant_id,
        module=config.filestore_module,
        timeout_seconds=config.request_timeout_seconds,
    )
