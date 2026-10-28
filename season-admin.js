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

// Map member fields. Awards are stored in the existing plain-text Títulos Obtenidos field.
function memberFieldMap(node) {
  const out = {};
  for (const field of node.fields || []) out[field.key] = field.value;
  return out;
}

function memberIdentifier(fields) {
  return String(fields.identificador_miembro || fields.identificador_del_miembro || "").trim();
}

function existingTitles(raw) {
  return String(raw || "").split(/\\s*[|;\\n]\\s*/).map(v => v.trim()).filter(Boolean);
}

async function updateMemberTitles(shopifyQuery, member, awardTitle) {
  const fields = memberFieldMap(member);
  const fieldKey = ["titulos_obtenidos", "títulos_obtenidos", "titulos_obtenidos_", "títulos_obtenidos_"].find(key => fields[key] !== undefined);
  if (!fieldKey) throw new Error("El perfil " + member.handle + " no tiene el campo Títulos Obtenidos con una clave compatible.");

  const titles = existingTitles(fields[fieldKey]);
  if (titles.some(title => title.toLocaleLowerCase() === awardTitle.toLocaleLowerCase())) {
    return { updated: false, reason: "already-awarded" };
  }

  const result = await shopifyQuery(
    'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }',
    { id: member.id, fields: [{ key: fieldKey, value: [...titles, awardTitle].join(" | ") }] }
  );
  const errors = result?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  if (!result?.metaobjectUpdate?.metaobject) throw new Error("Shopify no confirmó la actualización del perfil " + member.handle);
  return { updated: true };
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

  async function buildPreview(season, category) {
    const shortCategory = category.includes("·") ? category.split("·").pop().trim() : category;
    const nodes = await fetchMetaobjects("registro_competicion");
    const params = new URLSearchParams({ category: shortCategory });
    const ranking = filterLeaderboard(nodes.map(normalizeRecord), params)
      .filter(record => record.season.toLocaleLowerCase() === season.toLocaleLowerCase());
    const memberNodes = await fetchMetaobjects("perfil_de_miembro");
    const membersById = new Map();
    let duplicateIds = [];
    for (const member of memberNodes) {
      const id = memberIdentifier(memberFieldMap(member));
      if (!id) continue;
      const key = id.toLocaleLowerCase();
      if (membersById.has(key)) duplicateIds.push(id);
      else membersById.set(key, member);
    }
    const assignments = ranking.map(row => {
      const memberId = memberIdentifier(row.fields || {});
      const member = memberId ? membersById.get(memberId.toLocaleLowerCase()) : null;
      return { rank: row.rank, player: row.player, memberId: memberId || null, matchedMember: Boolean(member), memberHandle: member?.handle || null };
    });
    return {
      ranking,
      titleAssignmentPreview: {
        membersWithId: membersById.size,
        matched: assignments.filter(item => item.matchedMember).length,
        unmatched: assignments.filter(item => !item.matchedMember).map(({ rank, player, memberId }) => ({ rank, player, memberId })),
        duplicateMemberIds: [...new Set(duplicateIds)],
        note: "Cada registro de competición debe incluir identificador_miembro (ej. avalon001). No se asocian perfiles por nombre."
      }
    };
  }

  if (req.method === "GET" && url.pathname === "/api/admin/seasons/preview") {
    try {
      const season = clean(url.searchParams.get("season"));
      const category = clean(url.searchParams.get("category")) || "Origin · Jefes";
      if (!season) return send(res, 400, { ok: false, error: "Indica la temporada exacta para previsualizar." });
      const preview = await buildPreview(season, category);
      return send(res, 200, { ok: true, season, category, count: preview.ranking.length, ranking: preview.ranking, titleAssignmentPreview: preview.titleAssignmentPreview });
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
        if (!season) return send(res, 400, { ok: false, error: "Escribe el nombre exacto de la temporada." });

        const preview = await buildPreview(season, category);
        const ranking = preview.ranking;
        if (!ranking.length) return send(res, 409, { ok: false, error: "No hay registros para esa temporada y categoría; no se archivó nada." });
        if (preview.titleAssignmentPreview.duplicateMemberIds.length) {
          return send(res, 409, { ok: false, error: "Hay IDs de miembro duplicados. No se archivó ni se asignaron títulos.", duplicateMemberIds: preview.titleAssignmentPreview.duplicateMemberIds });
        }
        if (preview.titleAssignmentPreview.unmatched.length) {
          return send(res, 409, { ok: false, error: "Hay registros sin un perfil identificable por ID. Añade identificador_miembro al registro de competición y vuelve a intentarlo.", unmatched: preview.titleAssignmentPreview.unmatched.slice(0, 50), totalUnmatched: preview.titleAssignmentPreview.unmatched.length });
        }

        const archives = await fetchMetaobjects("avalon_season_archive");
        const alreadyClosed = archives.some(node => {
          const fields = memberFieldMap(node);
          return clean(fields.season_name).toLocaleLowerCase() === season.toLocaleLowerCase()
            && clean(fields.category).toLocaleLowerCase() === category.toLocaleLowerCase()
            && clean(fields.archive_status).toLocaleLowerCase() === "closed";
        });
        if (alreadyClosed) return send(res, 409, { ok: false, error: "Esta temporada y categoría ya están cerradas. No se duplicó el archivo ni se reasignaron títulos." });

        const members = await fetchMetaobjects("perfil_de_miembro");
        const byId = new Map();
        for (const member of members) {
          const id = memberIdentifier(memberFieldMap(member));
          if (id) byId.set(id.toLocaleLowerCase(), member);
        }

        // The durable snapshot is written first. No title mutation happens if archiving fails.
        const archive = await createSeasonArchive(shopifyQuery, season, category, ranking);
        const awards = [];
        for (const row of ranking) {
          const memberId = memberIdentifier(row.fields || {});
          const member = byId.get(memberId.toLocaleLowerCase());
          const title = clean(data.title) || (season + " · " + category);
          const result = await updateMemberTitles(shopifyQuery, member, title);
          awards.push({ rank: row.rank, player: row.player, memberId, title, updated: result.updated, reason: result.reason || null });
        }

        return send(res, 201, {
          ok: true,
          message: "Temporada archivada y títulos procesados.",
          archive,
          rankingCount: ranking.length,
          titlesGranted: awards.filter(award => award.updated).length,
          titlesAlreadyPresent: awards.filter(award => !award.updated).length,
          awards,
          note: "Los registros originales se conservaron. Los miembros se identificaron exclusivamente por identificador_miembro."
        });
      } catch (error) {
        send(res, 502, { ok: false, error: error.message || "No se pudo cerrar la temporada." });
      }
    });
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin };
