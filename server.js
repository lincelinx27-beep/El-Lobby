const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SHOPIFY_SHOP = (process.env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function validShop(shop) {
  return typeof shop === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
async function getToken() {
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, grant_type: "client_credentials" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "Shopify rechazó las credenciales.");
  return data.access_token;
}
async function testShopify() {
  const token = await getToken();
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": token },
    body: JSON.stringify({ query: "query { shop { name myshopifyDomain } metaobjectDefinitions(first: 20) { nodes { type name } } }" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors?.length) throw new Error("Shopify rechazó la consulta. Verifica instalación, permisos y organización de la app.");
  return data.data;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL || "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return send(res, 200, {
      ok: true,
      service: "El Lobby — Gestor del Salón de la Fama",
      status: "servidor activo",
      shopifyConfigured: Boolean(APP_URL && SHOPIFY_API_KEY && SHOPIFY_API_SECRET && validShop(SHOPIFY_SHOP)),
      shop: validShop(SHOPIFY_SHOP) ? SHOPIFY_SHOP : null,
      shopifyConnected: false,
      testEndpoint: "/shopify-test"
    });
  }
  if (req.method === "GET" && url.pathname === "/shopify-test") {
    if (!APP_URL || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !validShop(SHOPIFY_SHOP)) {
      return send(res, 503, { ok: false, connected: false, error: "Revisa APP_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET y SHOPIFY_SHOP en Render." });
    }
    try {
      const data = await testShopify();
      return send(res, 200, { ok: true, connected: true, shop: data.shop, metaobjectDefinitions: data.metaobjectDefinitions.nodes });
    } catch (error) {
      return send(res, 502, { ok: false, connected: false, error: error.message, hint: "La app y la tienda deben permitir este tipo de acceso y tener permisos de metaobjetos." });
    }
  }
  return send(res, 404, { ok: false, error: "No encontrado" });
});
server.listen(PORT, "0.0.0.0", () => console.log("El Lobby Gestor escuchando en el puerto " + PORT));
