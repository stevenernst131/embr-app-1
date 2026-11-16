import io
import json
import unittest
from unittest.mock import MagicMock, patch
from wsgiref.util import setup_testing_defaults

from app import application, container_client


class BlobTests(unittest.TestCase):
    def request(self, path, method="GET", body=b""):
        env = {}
        setup_testing_defaults(env)
        env.update(PATH_INFO=path, REQUEST_METHOD=method, CONTENT_LENGTH=str(len(body)), **{"wsgi.input": io.BytesIO(body)})
        result = {}
        def start(status, headers):
            result["status"] = status
        result["body"] = b"".join(application(env, start))
        return result

    @patch("app.ENDPOINT", "https://example.blob.core.windows.net")
    @patch("app.CONTAINER", "")
    def test_missing_container_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "AZURE_STORAGE_CONTAINER is not configured"):
            container_client()

    @patch("app.container_client")
    def test_upload_and_download(self, client):
        blob = client.return_value.get_blob_client.return_value
        blob.download_blob.return_value.readall.return_value = b"hello"
        upload = self.request("/blobs/test.txt", "PUT", b"hello")
        self.assertEqual(upload["status"], "201 Created")
        blob.upload_blob.assert_called_once_with(b"hello", overwrite=True)
        download = self.request("/blobs/test.txt")
        self.assertEqual(download["body"], b"hello")

    @patch("app.container_client")
    def test_list_and_bad_name(self, client):
        item = MagicMock()
        item.name = "one.txt"
        client.return_value.list_blobs.return_value.by_page.return_value = iter([[item]])
        self.assertEqual(json.loads(self.request("/blobs")["body"]), {"blobs": ["one.txt"]})
        self.assertEqual(self.request("/blobs/invalid/name", "PUT", b"x")["status"], "400 Bad Request")

    @patch("app.container_client", side_effect=RuntimeError("failure"))
    def test_error_is_sanitized(self, client):
        result = self.request("/blobs")
        self.assertEqual(result["status"], "500 Internal Server Error")
        self.assertNotIn(b"failure", result["body"])


if __name__ == "__main__":
    unittest.main()
