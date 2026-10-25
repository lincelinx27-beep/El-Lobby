const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const BUILD = "lobby-shopify-test-2026-10-25";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SHOPIFY_SHOP = (process.env.SHOPIFY_SHOP || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/$/, "");
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(body, null, 2));
}
function validShop(shop) {
  return typeof shop === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
function configured() {
  return Boolean(APP_URL && SHOPIFY_API_KEY && SHOPIFY_API_SECRET && validShop(SHOPIFY_SHOP));
}

async function getToken() {
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      grant_type: "client_credentials"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const reason = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`Token Shopify: ${String(reason).slice(0, 240)}`);
  }
  return data.access_token;
}

async function shopifyQuery(query) {
  const token = await getToken();
  const response = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-shopify-access-token": token
      },
      body: JSON.stringify({ query })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Admin API Shopify: HTTP ${response.status}. Revisa versión API, instalación y permisos.`);
  }
  if (data.errors?.length) {
    const messages = data.errors.map((item) => item.message).filter(Boolean).join("; ");
    throw new Error(`GraphQL Shopify: ${(messages || "consulta rechazada").slice(0, 300)}`);
  }
  return data.data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL || "http://localhost");

  if (req.method === "GET" && ["/", "/health", "/version"].includes(url.pathname)) {
    return send(res, 200, {
      ok: true,
      service: "El Lobby — Gestor del Salón de la Fama",
      status: "servidor activo",
      build: BUILD,
      shopifyConfigured: configured(),
      shop: validShop(SHOPIFY_SHOP) ? SHOPIFY_SHOP : null,
      testEndpoint: "/shopify-test",
      note: "Este estado confirma configuración; usa /shopify-test para probar autenticación real."
    });
  }

  if (req.method === "GET" && url.pathname === "/shopify-test") {
    if (!configured()) {
      return send(res, 503, {
        ok: false,
        connected: false,
        build: BUILD,
        error: "Configuración incompleta. Revisa APP_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET y SHOPIFY_SHOP en Render; SHOPIFY_SHOP debe ser el dominio completo terminado en .myshopify.com."
      });
    }
    try {
      const data = await shopifyQuery(
        "query { shop { name myshopifyDomain } metaobjectDefinitions(first: 30) { nodes { type name } } }"
      );
      return send(res, 200, {
        ok: true,
        connected: true,
        build: BUILD,
        shop: data.shop,
        metaobjectDefinitions: data.metaobjectDefinitions.nodes
      });
    } catch (error) {
      return send(res, 502, {
        ok: false,
        connected: false,
        build: BUILD,
        error: error.message || "No se pudo conectar con Shopify.",
        hint: "Si aparece shop_not_permitted, la app y la tienda no cumplen el requisito de organización para client credentials. Si aparece access denied, revisa permisos e instalación."
      });
    }
  }

  return send(res, 404, {
    ok: false,
    error: "No encontrado",
    build: BUILD,
    requestedPath: url.pathname,
    availablePaths: ["/", "/health", "/version", "/shopify-test"]
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`El Lobby Gestor ${BUILD} escuchando en el puerto ${PORT}`);
});
