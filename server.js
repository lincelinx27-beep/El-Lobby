const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SCOPES = process.env.SHOPIFY_SCOPES || "read_metaobjects,write_metaobjects";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}
function validShop(shop) {
  return typeof shop === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}
function safeEqual(a, b) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function verifyShopifyHmac(params) {
  const supplied = params.get("hmac");
  if (!supplied || !SHOPIFY_API_SECRET) return false;
  const pairs = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  const digest = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(pairs.join("&")).digest("hex");
  return safeEqual(digest, supplied);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL || "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return send(res, 200, {
      ok: true,
      service: "El Lobby — Gestor del Salón de la Fama",
      status: "servidor activo",
      shopifyConfigured: Boolean(APP_URL && SHOPIFY_API_KEY && SHOPIFY_API_SECRET),
      shopifyConnected: false,
      note: "La conexión OAuth necesita configurar las variables secretas y autorizar la tienda."
    });
  }

  if (req.method === "GET" && url.pathname === "/auth") {
    const shop = url.searchParams.get("shop") || "";
    if (!validShop(shop)) return send(res, 400, { ok: false, error: "Indica tu dominio de tienda, por ejemplo tienda.myshopify.com." });
    if (!APP_URL || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return send(res, 503, { ok: false, error: "Falta configurar APP_URL, SHOPIFY_API_KEY y SHOPIFY_API_SECRET en el servicio." });
    }
    const state = crypto.randomBytes(24).toString("hex");
    const redirect = new URL("/auth/callback", APP_URL).toString();
    const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
    authorize.searchParams.set("client_id", SHOPIFY_API_KEY);
    authorize.searchParams.set("scope", SCOPES);
    authorize.searchParams.set("redirect_uri", redirect);
    authorize.searchParams.set("state", state);
    res.writeHead(302, {
      location: authorize.toString(),
      "set-cookie": `lobby_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/auth/callback") {
    const params = url.searchParams;
    const shop = params.get("shop") || "";
    const state = params.get("state") || "";
    const cookieHeader = req.headers.cookie || "";
    const cookieState = (cookieHeader.match(/(?:^|;\s*)lobby_oauth_state=([^;]+)/) || [])[1] || "";
    if (!validShop(shop) || !state || !cookieState || !safeEqual(state, cookieState)) {
      return send(res, 400, { ok: false, error: "Estado OAuth inválido. Inicia la autorización de nuevo." });
    }
    if (!verifyShopifyHmac(params)) {
      return send(res, 400, { ok: false, error: "No se pudo verificar la firma de Shopify." });
    }
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return send(res, 503, { ok: false, error: "Faltan las credenciales de la aplicación en el servidor." });
    }
    const code = params.get("code");
    if (!code) return send(res, 400, { ok: false, error: "Shopify no devolvió un código de autorización." });
    try {
      const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code })
      });
      if (!response.ok) return send(res, 502, { ok: false, error: "Shopify rechazó el intercambio del código. Revisa la URL de callback y la configuración de la app." });
      const tokenData = await response.json();
      // Deliberadamente no se guarda ni se devuelve el token todavía.
      // La persistencia segura y el almacenamiento por tienda deben implementarse antes de operar con metaobjetos.
      return send(res, 200, {
        ok: true,
        authorized: true,
        shop,
        scopes: tokenData.scope || SCOPES,
        nextStep: "Autorización completada. Falta guardar el token de forma segura para habilitar operaciones."
      }, { "set-cookie": "lobby_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
    } catch {
      return send(res, 502, { ok: false, error: "No se pudo contactar a Shopify. Intenta de nuevo." });
    }
  }

  return send(res, 404, { ok: false, error: "No encontrado" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`El Lobby Gestor escuchando en el puerto ${PORT}`);
});
