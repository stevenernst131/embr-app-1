# Python Builder App

A single WSGI application serves the site at `/` and exposes its health check
at `/health`.

Both endpoints support `GET` and `HEAD`. `HEAD` returns the same status and
headers as `GET`, without a response body.
Other methods on these endpoints return `405 Method Not Allowed` with
`Allow: GET, HEAD`. Unknown routes return `404 Not Found`.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Set `PORT` to override the default port of `8080`.

Run the regression tests with `python -m unittest discover -v`.
