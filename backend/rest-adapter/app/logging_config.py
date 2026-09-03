"""One JSON object per line, so Promtail/Fluent Bit can ship this straight to
Loki/Elasticsearch for Grafana without a custom parser.

Rotates by size in LOG_DIR so the folder never grows unbounded. LOG_LEVEL=DEBUG
additionally turns on full request logging to PGR - see app/pgr/client.py.
"""

import json
import logging
import os
from logging.handlers import RotatingFileHandler

LOG_FILENAME = "app.log"
CONSOLE_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"

# Attributes every LogRecord already has - anything else on the record is a
# caller-supplied `extra` field and gets merged into the JSON line as-is.
_STANDARD_RECORD_FIELDS = frozenset(logging.LogRecord(
    "", 0, "", 0, "", (), None
).__dict__.keys()) | {"message"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S.%f%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        for key, value in record.__dict__.items():
            if key not in _STANDARD_RECORD_FIELDS:
                payload[key] = value

        return json.dumps(payload, default=str)

def configure_logging(config) -> None:
    settings = config.logging
    os.makedirs(settings.dir, exist_ok=True)

    formatter = JsonFormatter()
    handlers = []

    if settings.output in ("file", "both"):
        file_handler = RotatingFileHandler(
            os.path.join(settings.dir, LOG_FILENAME),
            maxBytes=settings.max_bytes,
            backupCount=settings.backup_count,
        )
        file_handler.setFormatter(formatter)
        handlers.append(file_handler)

    if settings.output in ("console", "both"):
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(logging.Formatter(CONSOLE_FORMAT))
        handlers.append(console_handler)


    root_logger = logging.getLogger()
    root_logger.setLevel(settings.level)
    root_logger.handlers = handlers

