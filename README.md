# Python Builder App

A single WSGI application serves the site at `/` and exposes its health check
at `/health`.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Set `PORT` to override the default port of `8080`.
