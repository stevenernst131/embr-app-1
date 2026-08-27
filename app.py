import json
import os
from wsgiref.simple_server import make_server


def application(environ, start_response):
    path = environ.get("PATH_INFO", "/")

    if path == "/health":
        body = json.dumps({"status": "healthy"}).encode()
        start_response(
            "200 OK",
            [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
            ],
        )
        return [body]

    if path == "/":
        body = b"Hello from the Embr Python Builder App!\n"
        start_response(
            "200 OK",
            [
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Content-Length", str(len(body))),
            ],
        )
        return [body]

    body = b"Not found\n"
    start_response(
        "404 Not Found",
        [
            ("Content-Type", "text/plain; charset=utf-8"),
            ("Content-Length", str(len(body))),
        ],
    )
    return [body]


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    with make_server("0.0.0.0", port, application) as server:
        print(f"Serving on http://0.0.0.0:{port}")
        server.serve_forever()
