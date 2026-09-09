"""Turns DIGIT codes into words a citizen can read.

Master data is all codes — WATER_SUPPLY, DEPT_8, ADMIN_LOC_01 — so every list the
portal shows needs the deployment's own translations. Bundles are cached per locale
because they change only when someone edits the localisation masters.
"""

import threading

import requests

LOCALISATION_PATH = "localization/messages/v1/_search"
JSON_HEADERS = {"Content-Type": "application/json"}


class LabelService:
    def __init__(self, digit_host, root_tenant_id, modules, default_locale, timeout_seconds):
        self._digit_host = digit_host
        self._root_tenant_id = root_tenant_id
        self._modules = modules
        self._default_locale = default_locale
        self._timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._by_locale = {}

    def translator(self, locale):
        """Returns `translate(code, fallback)` so callers never handle a missing label."""
        messages = self._bundle(locale or self._default_locale)

        def translate(code, fallback=None):
            return messages.get(code) or fallback or code

        return translate

    def _bundle(self, locale) -> dict:
        with self._lock:
            if locale not in self._by_locale:
                self._by_locale[locale] = self._fetch(locale)
            return self._by_locale[locale]

    def _fetch(self, locale) -> dict:
        """A missing bundle must not break a form, so any failure yields no labels."""
        try:
            response = requests.post(
                self._digit_host + LOCALISATION_PATH,
                params={
                    "tenantId": self._root_tenant_id,
                    "locale": locale,
                    "module": ",".join(self._modules),
                },
                json={"RequestInfo": {"apiId": "Rainmaker"}},
                headers=JSON_HEADERS,
                timeout=self._timeout_seconds,
            )
            if response.status_code != 200:
                return {}
            return _messages_by_code(response.json())
        except requests.RequestException:
            return {}


def _messages_by_code(body: dict) -> dict:
    return {entry["code"]: entry["message"] for entry in (body.get("messages") or []) if entry.get("code")}
