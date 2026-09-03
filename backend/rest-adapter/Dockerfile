FROM python:3.11-slim

WORKDIR /adapter

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# app/api/openapi.yaml ships inside the package and is served at /docs
COPY app ./app
COPY run.py .

ENV LOG_DIR=/var/adapter/logs
VOLUME ["/var/adapter/logs"]

EXPOSE 8090
CMD ["gunicorn", "--bind", "0.0.0.0:8090", "--workers", "2", "run:app"]
