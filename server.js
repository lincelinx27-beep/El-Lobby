const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const BUILD = "avalon-community-clean";
const HTML_PATH = path.join(__dirname, "public", "index.html");

function send(res, status, body) {
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, process.env.APP_URL || "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    if (!fs.existsSync(HTML_PATH)) {
      return send(res, 500, { ok: false, error: "No se encontró public/index.html." });
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache"
    });
    return fs.createReadStream(HTML_PATH).pipe(res);
  }

  if (req.method === "GET" && ["/health", "/version"].includes(url.pathname)) {
    return send(res, 200, {
      ok: true,
      service: "Avalon Community",
      status: "servidor activo",
      build: BUILD
    });
  }

  return send(res, 404, { ok: false, error: "No encontrado", build: BUILD });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Avalon Community ${BUILD} escuchando en el puerto ${PORT}`);
});
