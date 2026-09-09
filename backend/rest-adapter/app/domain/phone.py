"""Reduces a phone number to the national form DIGIT stores it under.

Phone identity is per-country configuration, not code: `country_code` is the dialling
prefix without '+', `national_length` the length of the number after it. The rule
matches the WhatsApp chatbot's `sanitizeMobileNumber`, so a citizen who writes in on
one channel and walks into a reception desk on the other is the same person.

DIGIT stores the national form as the username, and looks it up by exact match. So
'+258 84 000 0000', '258840000000' and '840000000' must all reduce to '840000000',
or the citizen gets a second user record and their complaint history splits in two.
"""

import re

from app.domain.errors import InvalidRequest

NON_DIGITS = re.compile(r"\D")


class PhoneNumbers:
    def __init__(self, country_code, national_length):
        self._country_code = NON_DIGITS.sub("", str(country_code))
        self._national_length = national_length

    def normalise(self, raw) -> str:
        national = self._to_national(NON_DIGITS.sub("", str(raw or "")))
        if national is None:
            raise InvalidRequest(
                f"'{raw}' is not a valid mobile number: expected {self._national_length} digits, "
                f"optionally prefixed with {self._country_code}"
            )
        return national

    def _to_national(self, digits):
        if len(digits) == self._national_length:
            return digits
        if self._country_code and digits.startswith(self._country_code):
            without_prefix = digits[len(self._country_code):]
            if len(without_prefix) == self._national_length:
                return without_prefix
        return None
