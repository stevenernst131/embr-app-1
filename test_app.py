import json
import unittest
from wsgiref.util import setup_testing_defaults

from app import application


class ApplicationTests(unittest.TestCase):
    def request(self, path, method="GET"):
        environ = {}
        setup_testing_defaults(environ)
        environ.update(PATH_INFO=path, REQUEST_METHOD=method)
        response = {}

        def start_response(status, headers):
            response["status"] = status
            response["headers"] = dict(headers)

        response["body"] = b"".join(application(environ, start_response))
        return response

    def test_home(self):
        response = self.request("/")
        self.assertEqual(response["status"], "200 OK")
        self.assertEqual(
            response["body"], b"Hello from the Embr Python Builder App!\n"
        )
        self.assertEqual(
            response["headers"]["Content-Type"], "text/plain; charset=utf-8"
        )
        self.assertEqual(
            int(response["headers"]["Content-Length"]), len(response["body"])
        )

    def test_health(self):
        response = self.request("/health")
        self.assertEqual(response["status"], "200 OK")
        self.assertEqual(json.loads(response["body"]), {"status": "healthy"})
        self.assertEqual(response["headers"]["Content-Type"], "application/json")
        self.assertEqual(
            int(response["headers"]["Content-Length"]), len(response["body"])
        )

    def test_missing_route(self):
        response = self.request("/missing")
        self.assertEqual(response["status"], "404 Not Found")
        self.assertEqual(response["body"], b"Not found\n")
        self.assertEqual(
            int(response["headers"]["Content-Length"]), len(response["body"])
        )

    def test_health_responses_must_not_be_cached(self):
        for method in ("GET", "HEAD"):
            with self.subTest(method=method):
                response = self.request("/health", method)
                self.assertEqual(response["headers"]["Cache-Control"], "no-store")

    def test_head_has_get_headers_without_body(self):
        for path in ("/", "/health", "/missing"):
            with self.subTest(path=path):
                get_response = self.request(path)
                head_response = self.request(path, "HEAD")
                self.assertEqual(head_response["status"], get_response["status"])
                self.assertEqual(head_response["headers"], get_response["headers"])
                self.assertEqual(head_response["body"], b"")

    def test_unsupported_methods_on_known_routes(self):
        for path in ("/", "/health"):
            for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"):
                with self.subTest(path=path, method=method):
                    response = self.request(path, method)
                    self.assertEqual(response["status"], "405 Method Not Allowed")
                    self.assertEqual(response["headers"]["Allow"], "GET, HEAD")
                    self.assertEqual(response["body"], b"Method not allowed\n")
                    self.assertEqual(
                        int(response["headers"]["Content-Length"]),
                        len(response["body"]),
                    )

    def test_unsupported_method_on_missing_route_still_returns_not_found(self):
        response = self.request("/missing", "POST")
        self.assertEqual(response["status"], "404 Not Found")
        self.assertNotIn("Allow", response["headers"])


if __name__ == "__main__":
    unittest.main()
