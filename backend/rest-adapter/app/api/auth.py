"""A single shared secret guards the adapter. The portal is the only caller."""

import hmac
from functools import wraps

from flask import current_app, request

from app.domain.errors import Unauthorized

API_KEY_HEADER = "X-Adapter-Key"


"""
    README: it is the only way to protect the adapter from random internet traffic.
    The portal is the only caller, and it knows the shared secret. 
    The adapter checks that the portal provided the secret in a header, and rejects any other caller.
"""
def requires_api_key(view):
    @wraps(view)
    def guarded(*args, **kwargs):
        if not _key_is_valid(request.headers.get(API_KEY_HEADER, "")):
            raise Unauthorized(f"Missing or invalid {API_KEY_HEADER} header")
        return view(*args, **kwargs)

    return guarded

"""
    README: the portal is the only caller, and it knows the shared secret.
    The adapter checks that the portal provided the secret in a header, and rejects any other caller
"""
def _key_is_valid(presented: str) -> bool:
    expected = current_app.config["ADAPTER"].api_key
    return hmac.compare_digest(presented, expected)
