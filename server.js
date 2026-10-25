const http = require("node:http");

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      service: "El Lobby — Gestor del Salón de la Fama",
      status: "servidor inicial activo",
      shopifyConnected: false,
      note: "La conexión con Shopify todavía no está configurada."
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "No encontrado" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`El Lobby Gestor escuchando en el puerto ${port}`);
});
