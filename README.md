# Python Builder Blob validation app

The app exposes GET /health, GET /blobs, PUT /blobs/{name} (1–4096 bytes) and GET /blobs/{name}. Blob operations use the app's system-assigned managed identity and the `AZURE_STORAGE_BLOB_ENDPOINT` and `AZURE_STORAGE_CONTAINER` runtime variables. Grant Storage Blob Data Contributor to that identity on the storage account. No storage keys are used.

This test app has no caller authentication: anyone who can reach it can read and overwrite blobs. Use a disposable account and container only. Structured JSON events on stdout show startup configuration, requests and Azure operation results; they do not include blob contents.

Run `python -m unittest discover -v` for local tests. Deploy the committed `builder.yaml` with Builder CLI.
