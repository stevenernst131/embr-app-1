import json
import os
from wsgiref.simple_server import make_server


def _respond(environ, start_response, status, content_type, body, extra_headers=()):
    start_response(
        status,
        [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            *extra_headers,
        ],
    )
    return [] if environ.get("REQUEST_METHOD") == "HEAD" else [body]


def application(environ, start_response):
    path = environ.get("PATH_INFO", "/")

    if path in ("/", "/health") and environ.get("REQUEST_METHOD", "GET") not in (
        "GET",
        "HEAD",
    ):
        return _respond(
            environ,
            start_response,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method not allowed\n",
            [("Allow", "GET, HEAD")],
        )

    if path == "/health":
        body = json.dumps({"status": "healthy"}).encode()
        return _respond(
            environ,
            start_response,
            "200 OK",
            "application/json",
            body,
        )

    if path == "/":
        body = b"Hello from the Embr Python Builder App!\n"
        return _respond(
            environ,
            start_response,
            "200 OK",
            "text/plain; charset=utf-8",
            body,
        )

    body = b"Not found\n"
    return _respond(
        environ,
        start_response,
        "404 Not Found",
        "text/plain; charset=utf-8",
        body,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    with make_server("0.0.0.0", port, application) as server:
        print(f"Serving on http://0.0.0.0:{port}")
        server.serve_forever()
