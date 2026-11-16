import json
import logging
import os
import re
import sys
import time
from wsgiref.simple_server import make_server

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient

logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s", force=True)
logger = logging.getLogger("blob_validation")
ENDPOINT = os.environ.get("AZURE_STORAGE_ACCOUNT_URL", "")
CONTAINER = os.environ.get("AZURE_STORAGE_CONTAINER", "")
_client = None


def log(event, **fields):
    logger.info(json.dumps({"event": event, **fields}, default=str))


log("startup", endpoint=ENDPOINT, container=CONTAINER, credential="ManagedIdentityCredential", configured=bool(ENDPOINT and CONTAINER))


def container_client():
    global _client
    if not ENDPOINT:
        raise ValueError("AZURE_STORAGE_ACCOUNT_URL is not configured")
    if not CONTAINER:
        raise ValueError("AZURE_STORAGE_CONTAINER is not configured")
    if _client is None:
        _client = BlobServiceClient(account_url=ENDPOINT, credential=ManagedIdentityCredential()).get_container_client(CONTAINER)
    return _client


def respond(environ, start_response, status, content_type, body, extra_headers=()):
    start_response(status, [("Content-Type", content_type), ("Content-Length", str(len(body))), *extra_headers])
    return [] if environ.get("REQUEST_METHOD") == "HEAD" else [body]


def json_response(environ, start_response, status, payload):
    return respond(environ, start_response, status, "application/json", json.dumps(payload).encode())


def application(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    method = environ.get("REQUEST_METHOD", "GET")
    started = time.monotonic()
    status_code = "500 Internal Server Error"

    def reply(status, content_type, body, headers=()):
        nonlocal status_code
        status_code = status
        return respond(environ, start_response, status, content_type, body, headers)

    def json_reply(status, payload):
        return reply(status, "application/json", json.dumps(payload).encode())

    try:
        if path in ("/", "/health"):
            if method not in ("GET", "HEAD"):
                return reply("405 Method Not Allowed", "text/plain; charset=utf-8", b"Method not allowed\n", [("Allow", "GET, HEAD")])
            if path == "/health":
                return reply("200 OK", "application/json", b'{"status": "healthy"}', [("Cache-Control", "no-store")])
            return reply("200 OK", "text/plain; charset=utf-8", b"Hello from the Embr Python Builder App!\n")

        if path == "/blobs" and method == "GET":
            operation = "list"
            try:
                names = [item.name for item in container_client().list_blobs(results_per_page=50).by_page().__next__()]
                log("azure_call_succeeded", operation=operation, container=CONTAINER, count=len(names))
                return json_reply("200 OK", {"blobs": names})
            except StopIteration:
                log("azure_call_succeeded", operation=operation, container=CONTAINER, count=0)
                return json_reply("200 OK", {"blobs": []})
        if path.startswith("/blobs/") and method in ("GET", "PUT"):
            name = path[len("/blobs/"):]
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", name):
                return json_reply("400 Bad Request", {"error": "Invalid blob name"})
            blob = container_client().get_blob_client(name)
            if method == "PUT":
                length = int(environ.get("CONTENT_LENGTH") or "0")
                if length < 1 or length > 4096:
                    return json_reply("400 Bad Request", {"error": "Body must be 1-4096 bytes"})
                data = environ["wsgi.input"].read(length)
                blob.upload_blob(data, overwrite=True)
                log("azure_call_succeeded", operation="upload", container=CONTAINER, blob=name, bytes=len(data))
                return json_reply("201 Created", {"blob": name, "bytes": len(data)})
            data = blob.download_blob().readall()
            log("azure_call_succeeded", operation="download", container=CONTAINER, blob=name, bytes=len(data))
            return reply("200 OK", "application/octet-stream", data)
        return reply("404 Not Found", "text/plain; charset=utf-8", b"Not found\n")
    except ResourceNotFoundError as exc:
        log("azure_call_failed", method=method, path=path, exception=type(exc).__name__, status=getattr(exc, "status_code", None), error_code=getattr(exc, "error_code", None))
        return json_reply("404 Not Found", {"error": "Blob or container not found"})
    except Exception as exc:
        log("azure_call_failed", method=method, path=path, exception=type(exc).__name__, status=getattr(exc, "status_code", None), error_code=getattr(exc, "error_code", None))
        return json_reply("500 Internal Server Error", {"error": "Azure operation failed", "type": type(exc).__name__})
    finally:
        log("request", method=method, path=path, status=status_code, duration_ms=round((time.monotonic() - started) * 1000, 1))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    with make_server("0.0.0.0", port, application) as server:
        server.serve_forever()
