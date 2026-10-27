// Avalon Season Admin — protected archive routes
const ADMIN_TOKEN = process.env.AVALON_ADMIN_TOKEN || "";

function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(ADMIN_TOKEN && token && token === ADMIN_TOKEN);
}

async function ensureSeasonDefinition(shopifyQuery) {
  const found = await shopifyQuery('query { metaobjectDefinitionByType(type: "avalon_season_archive") { id type } }');
  if (found.metaobjectDefinitionByType) return;

  const result = await shopifyQuery('mutation { metaobjectDefinitionCreate(definition: { type: "avalon_season_archive", name: "Avalon Season Archive", fieldDefinitions: [{ key: "season_name", name: "Season name", type: "single_line_text_field" }, { key: "closed_at", name: "Closed at", type: "date_time" }, { key: "category", name: "Category", type: "single_line_text_field" }, { key: "ranking_json", name: "Final ranking snapshot", type: "json" }, { key: "archive_status", name: "Archive status", type: "single_line_text_field" }] }) { metaobjectDefinition { id type } userErrors { field message } } }');
  const errors = result?.metaobjectDefinitionCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
  if (!result?.metaobjectDefinitionCreate?.metaobjectDefinition) {
    throw new Error("Shopify no confirmó la creación de la definición de archivo.");
  }
}

async function createSeasonArchive(shopifyQuery, name, category, ranking) {
  await ensureSeasonDefinition(shopifyQuery);
  const handle = "season-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now();
  const fields = [
    { key: "season_name", value: name },
    { key: "closed_at", value: new Date().toISOString() },
    { key: "category", value: category },
    { key: "ranking_json", value: JSON.stringify(ranking) },
    { key: "archive_status", value: "closed" }
  ];
  const result = await shopifyQuery(
    'mutation($handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: {type: "avalon_season_archive", handle: $handle, fields: $fields}) { metaobject { id handle } userErrors { field message } } }',
    { handle, fields }
  );
  const errors = result?.metaobjectCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
  if (!result?.metaobjectCreate?.metaobject) {
    throw new Error("Shopify no confirmó el archivo de la temporada.");
  }
  return result.metaobjectCreate.metaobject;
}

async function handleSeasonAdmin(req, res, url, deps) {
  const { send, clean, shopifyQuery, fetchMetaobjects, normalizeRecord, filterLeaderboard } = deps;
  if (!url.pathname.startsWith("/api/admin/seasons")) return false;
  if (!ADMIN_TOKEN) {
    send(res, 503, { ok: false, error: "Falta configurar AVALON_ADMIN_TOKEN en el servidor." });
    return true;
  }
  if (!authorized(req)) {
    send(res, 401, { ok: false, error: "Acceso denegado. Introduce la clave de administrador." });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/seasons/preview") {
    try {
      const season = clean(url.searchParams.get("season"));
      const category = clean(url.searchParams.get("category")) || "Origin · Jefes";
      const shortCategory = category.includes("·") ? category.split("·").pop().trim() : category;
      const nodes = await fetchMetaobjects("registro_competicion");
      const params = new URLSearchParams({ category: shortCategory });
      if (season) params.set("season", season);
      const ranking = filterLeaderboard(nodes.map(normalizeRecord), params)
        .filter(r => r.category.toLowerCase() === shortCategory.toLowerCase());
      send(res, 200, { ok: true, season, category, count: ranking.length, ranking });
    } catch (error) {
      send(res, 502, { ok: false, error: error.message || "Error consultando el ranking." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/seasons/close") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const season = clean(data.season);
        const category = clean(data.category) || "Origin · Jefes";
        if (!season) return send(res, 400, { ok: false, error: "Escribe el nombre de la temporada." });
        const shortCategory = category.includes("·") ? category.split("·").pop().trim() : category;
        const nodes = await fetchMetaobjects("registro_competicion");
        const params = new URLSearchParams({ season, category: shortCategory });
        const ranking = filterLeaderboard(nodes.map(normalizeRecord), params)
          .filter(r => r.category.toLowerCase() === shortCategory.toLowerCase());
        if (!ranking.length) {
          return send(res, 409, { ok: false, error: "No hay registros para esa temporada y categoría; no se archivó nada." });
        }
        const archive = await createSeasonArchive(shopifyQuery, season, category, ranking);
        return send(res, 201, {
          ok: true,
          message: "Temporada archivada. Los registros originales no se borraron.",
          archive,
          rankingCount: ranking.length,
          note: "Esta versión guarda una instantánea histórica; no asigna títulos a perfiles ni vacía el ranking."
        });
      } catch (error) {
        return send(res, 502, { ok: false, error: error.message || "No se pudo archivar la temporada." });
      }
    });
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin };
