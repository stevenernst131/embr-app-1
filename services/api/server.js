import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((request, response) => {
  const path = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (path === "/health" || path === "/api/health") {
    return sendJson(response, 200, { status: "healthy" });
  }

  if (path === "/status" || path === "/api/status") {
    return sendJson(response, 200, {
      appFormat: "static-spa-backend",
      source: "separate-api"
    });
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`API listening on port ${port}`);
});

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

