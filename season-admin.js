// Avalon Season Admin — isolated archival controls
const ADMIN_TOKEN = process.env.AVALON_ADMIN_TOKEN || "";
const SEASON_TYPE = "avalon_season_archive";
function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(ADMIN_TOKEN && token && token.length === ADMIN_TOKEN.length &&
    require("node:crypto").timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN)));
}
async function ensureSeasonDefinition() {
  const found = await shopifyQuery("query { metaobjectDefinitionByType(type: \"avalon_season_archive\") { id type } }");
  if (found.metaobjectDefinitionByType) return;
  const result = await shopifyQuery(`mutation {
    metaobjectDefinitionCreate(definition: {
      type: "avalon_season_archive", name: "Avalon Season Archive",
      fieldDefinitions: [
        { key: "season_name", name: "Season name", type: "single_line_text_field" },
        { key: "closed_at", name: "Closed at", type: "date_time" },
        { key: "category", name: "Category", type: "single_line_text_field" },
        { key: "ranking_json", name: "Final ranking snapshot", type: "json" },
        { key: "archive_status", name: "Archive status", type: "single_line_text_field" }
      ]
    }) { metaobjectDefinition { id type } userErrors { field message } }
  }`);
  const errors = result.metaobjectDefinitionCreate.userErrors || [];
  if (errors.length) throw new Error(errors.map(e=>e.message).join("; "));
}
async function createSeasonArchive(name, category, ranking) {
  await ensureSeasonDefinition();
  const handle = "season-" + name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + Date.now();
  const fields = [
    {key:"season_name",value:name},
    {key:"closed_at",value:new Date().toISOString()},
    {key:"category",value:category},
    {key:"ranking_json",value:JSON.stringify(ranking)},
    {key:"archive_status",value:"closed"}
  ];
  const result = await shopifyQuery(`mutation($handle: String!, $fields: [MetaobjectFieldInput!]!) {
    metaobjectCreate(metaobject: {type: "avalon_season_archive", handle: $handle, fields: $fields}) {
      metaobject { id handle }
      userErrors { field message }
    }
  }`,{handle,fields});
  const errors = result.metaobjectCreate.userErrors || [];
  if (errors.length) throw new Error(errors.map(e=>e.message).join("; "));
  return result.metaobjectCreate.metaobject;
}
async function handleSeasonAdmin(req,res,url) {
  if (!url.pathname.startsWith("/api/admin/seasons")) return false;
  if (!ADMIN_TOKEN) { send(res,503,{ok:false,error:"Falta configurar AVALON_ADMIN_TOKEN en el servidor."}); return true; }
  if (!authorized(req)) { send(res,401,{ok:false,error:"Acceso denegado. Introduce la clave de administrador."}); return true; }
  if (req.method === "GET" && url.pathname === "/api/admin/seasons/preview") {
    try {
      const category = clean(url.searchParams.get("category")) || "Origin · Jefes";
      const season = clean(url.searchParams.get("season"));
      const nodes = await fetchMetaobjects("registro_competicion");
      const params = new URLSearchParams({category:category.split(" · ").pop() || category});
      if (season) params.set("season",season);
      const records = filterLeaderboard(nodes.map(normalizeRecord),params)
        .filter(r => !category || (r.category.toLowerCase() === category.toLowerCase() || (category.includes("·") && r.category.toLowerCase() === category.split("·").pop().trim().toLowerCase())));
      send(res,200,{ok:true,category,season,count:records.length,ranking:records});
    } catch(error) { send(res,502,{ok:false,error:error.message}); }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/seasons/close") {
    let body = "";
    req.on("data",chunk=>{body+=chunk;if(body.length>100000){req.destroy();}});
    req.on("end",async()=>{
      try {
        const data = JSON.parse(body || "{}");
        const season = clean(data.season), category = clean(data.category) || "Origin · Jefes";
        if (!season) return send(res,400,{ok:false,error:"Escribe el nombre de la temporada."});
        const nodes = await fetchMetaobjects("registro_competicion");
        const shortCategory = category.includes("·") ? category.split("·").pop().trim() : category;
        const params = new URLSearchParams({season,category:shortCategory});
        const ranking = filterLeaderboard(nodes.map(normalizeRecord),params)
          .filter(r => r.category.toLowerCase() === shortCategory.toLowerCase());
        if (!ranking.length) return send(res,409,{ok:false,error:"No hay registros para esa temporada y categoría; no se archivó nada."});
        const archive = await createSeasonArchive(season,category,ranking);
        return send(res,201,{ok:true,message:"Temporada archivada. Los registros originales no se borraron.",archive,rankingCount:ranking.length,
          note:"Este cierre guarda una instantánea histórica. La asignación de títulos a perfiles y el vaciado del ranking no se ejecutan en esta versión."});
      } catch(error) { return send(res,502,{ok:false,error:error.message||"No se pudo archivar la temporada."}); }
    });
    return true;
  }
  send(res,404,{ok:false,error:"Ruta de administración no encontrada."}); return true;
}
