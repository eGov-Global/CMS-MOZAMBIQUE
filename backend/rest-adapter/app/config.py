"""Every value the adapter reads from the environment, in one place."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ReceptionOfficerCredentials:
    """The static identity the adapter files complaints as."""

    username: str
    password: str
    tenant_id: str
    basic_auth_header: str

    @property
    def is_complete(self) -> bool:
        return bool(self.username and self.password)


@dataclass(frozen=True)
class ComplaintDefaults:
    """Values the portal never sends, so the adapter supplies them."""

    source: str
    case_related_to: str
    citizen_name: str


@dataclass(frozen=True)
class MasterDataSettings:
    """Where the lists come from, and which language to label them in."""

    root_tenant_id: str
    localisation_modules: tuple
    default_locale: str

@dataclass(frozen=True)
class LoggingSettings:
    """Where logs go, how big they get before rotating, and how much detail."""

    dir: str
    level: str
    max_bytes: int
    backup_count: int
    output: str


@dataclass(frozen=True)
class Config:
    api_key: str
    port: int
    digit_host: str
    user_service_host: str
    city_tenant_id: str
    search_tenant_id: str
    extra_filers: tuple
    proxy_hops: int
    country_code: str
    mobile_number_length: int
    token_ttl_seconds: int
    request_timeout_seconds: int
    officer: ReceptionOfficerCredentials
    defaults: ComplaintDefaults
    master_data: MasterDataSettings
    filestore_module: str
    logging: LoggingSettings


def load_config() -> Config:
    return Config(
        api_key=_required("ADAPTER_API_KEY"),
        port=int(os.getenv("PORT", "8090")),
        digit_host=_host("DIGIT_HOST"),
        user_service_host=_host("USER_SERVICE_HOST"),
        city_tenant_id=_required("CITY_TENANT_ID"),
        # searching at the state root makes the tenant clause a prefix match, so
        # complaints filed under any city come back
        search_tenant_id=os.getenv("SEARCH_TENANT_ID") or _required("ROOT_TENANT_ID"),
        extra_filers=_csv("EXTRA_COMPLAINT_FILERS", ""),
        proxy_hops=int(os.getenv("PROXY_HOPS", "0")),
        country_code=os.getenv("COUNTRY_CODE", "258"),
        mobile_number_length=int(os.getenv("MOBILE_NUMBER_LENGTH", "9")),
        token_ttl_seconds=int(os.getenv("TOKEN_TTL_SECONDS", "900")),
        request_timeout_seconds=int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")),
        officer=ReceptionOfficerCredentials(
            username=os.getenv("RECEPTION_OFFICER_USERNAME", ""),
            password=os.getenv("RECEPTION_OFFICER_PASSWORD", ""),
            tenant_id=_required("ROOT_TENANT_ID"),
            basic_auth_header=os.getenv("OAUTH_BASIC_HEADER", "Basic ZWdvdi11c2VyLWNsaWVudDo="),
        ),
        defaults=ComplaintDefaults(
            source=os.getenv("COMPLAINT_SOURCE", "linhaverde"),
            case_related_to=os.getenv("CASE_RELATED_TO", "IGE"),
            citizen_name=os.getenv("DEFAULT_CITIZEN_NAME", "Citizen"),
        ),
        master_data=MasterDataSettings(
            root_tenant_id=_required("ROOT_TENANT_ID"),
            localisation_modules=_csv("LOCALISATION_MODULES", "rainmaker-pgr,common-masters"),
            default_locale=os.getenv("DEFAULT_LOCALE", "pt_PT"),
        ),
        filestore_module=os.getenv("FILESTORE_MODULE", "PGR"),
        logging=LoggingSettings(
            dir=os.getenv("LOG_DIR", "logs"),
            level=os.getenv("LOG_LEVEL", "INFO").upper(),
            max_bytes=int(os.getenv("LOG_MAX_BYTES", str(10 * 1024 * 1024))), # 10 MB
            backup_count=int(os.getenv("LOG_BACKUP_COUNT", "5")),
            output=os.getenv("LOG_OUTPUT", "both").lower(),
        ),
    )


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _csv(name: str, fallback: str) -> tuple:
    return tuple(part.strip() for part in os.getenv(name, fallback).split(",") if part.strip())


def _host(name: str) -> str:
    """Hosts are joined by concatenation, so a trailing slash is part of the contract."""
    return _required(name).rstrip("/") + "/"
