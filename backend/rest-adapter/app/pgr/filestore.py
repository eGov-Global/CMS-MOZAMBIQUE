"""Uploads complaint evidence to DIGIT's file store."""

import requests

from app.domain.errors import FileUploadFailed

FILES_PATH = "filestore/v1/files"
FILE_PATH = "filestore/v1/files/id"


class FileStoreClient:
    def __init__(self, digit_host, tenant_id, module, timeout_seconds):
        self._digit_host = digit_host
        self._tenant_id = tenant_id
        self._module = module
        self._timeout_seconds = timeout_seconds

    def upload(self, file_storage) -> str:
        query = {"tenantId": self._tenant_id, "module": self._module}
        files = {"file": (file_storage.filename, file_storage.stream, file_storage.content_type)}
        try:
            response = requests.post(
                self._digit_host + FILES_PATH, params=query, files=files, timeout=self._timeout_seconds
            )
        except requests.RequestException as error:
            raise FileUploadFailed(f"Could not reach the file store: {error}")

        if response.status_code not in (200, 201):
            raise FileUploadFailed(
                "File store rejected the upload",
                details={"status": response.status_code, "body": _short(response.text)},
            )
        return _file_store_id(response.json())

    def download(self, file_store_id: str):
        query = {"tenantId": self._tenant_id, "fileStoreId": file_store_id}
        try:
            response = requests.get(
                self._digit_host + FILE_PATH, params=query, timeout=self._timeout_seconds
            )
        except requests.RequestException as error:
            raise FileUploadFailed(f"Could not reach the file store: {error}")

        if response.status_code != 200:
            raise FileUploadFailed(
                "File store rejected the download",
                details={"status": response.status_code, "body": _short(response.text)},
            )
        return response.content, response.headers.get("Content-Type", "application/octet-stream")

    def metadata(self, file_store_id: str) -> dict:
        query = {"tenantId": self._tenant_id, "fileStoreId": file_store_id}
        try:
            response = requests.get(
                self._digit_host + FILE_PATH, params=query, timeout=self._timeout_seconds, stream=True
            )
        except requests.RequestException as error:
            raise FileUploadFailed(f"Could not reach the file store: {error}")

        with response:
            if response.status_code != 200:
                raise FileUploadFailed(
                    "File store rejected the metadata request",
                    details={"status": response.status_code},
                )
            return {
                "fileName": _file_name(response.headers.get("Content-Disposition")),
                "size": _int_or_none(response.headers.get("Content-Length")),
                "contentType": response.headers.get("Content-Type"),
            }



def _file_store_id(body: dict) -> str:
    files = body.get("files") or []
    if not files:
        raise FileUploadFailed("File store accepted the upload but returned no file")
    return files[0].get("fileStoreId")


def _short(text: str, limit: int = 500) -> str:
    return text[:limit]


def _file_name(content_disposition) -> str:
    if not content_disposition or "filename=" not in content_disposition:
        return None
    return content_disposition.split("filename=")[-1].strip('"; ')


def _int_or_none(value):
    return int(value) if value and value.isdigit() else None
