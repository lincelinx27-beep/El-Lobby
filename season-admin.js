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

// Update a member's Títulos Obtenidos field in the existing perfil_de_miembro metaobject.
async function updateMemberTitles(shopifyQuery, member, title, awardKey) {
  const fields = Object.fromEntries((member.fields || []).map(field => [field.key, field.value]));
  const currentRaw = fields.titulos_obtenidos ?? fields["títulos_obtenidos"] ?? fields.titulos_obtenidos_ ?? fields["títulos_obtenidos_"] ?? "";
  const current = currentRaw ? String(currentRaw).split(/\\s*[|;\\n]\\s*/).map(v => v.trim()).filter(Boolean) : [];
  // Titles are plain text in the merchant-defined field. Store a unique, human-readable
  // season/category/title entry and don't append it twice.
  const normalizedExisting = new Set(current.map(v => v.toLocaleLowerCase()));
  if (normalizedExisting.has(title.toLocaleLowerCase())) return { updated: false, reason: "already-awarded" };

  const titleValue = title;
  const titleFieldKey = ["titulos_obtenidos", "títulos_obtenidos", "titulos_obtenidos_", "títulos_obtenidos_"].find(key => fields[key] !== undefined);
  if (!titleFieldKey) {
    return { updated: false, reason: "missing-titulos_obtenidos-field" };
  }
  const nextValue = [...current, titleValue].join(" | ");
  const mutation = await shopifyQuery(
    'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }',
    { id: member.id, fields: [{ key: titleFieldKey, value: nextValue }] }
  );
  const errors = mutation?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
  if (!mutation?.metaobjectUpdate?.metaobject) throw new Error("Shopify no confirmó la actualización del perfil " + member.handle);
  return { updated: true };
}

function fieldMapForMember(node) {
  const out = {};
  for (const field of node.fields || []) out[field.key] = field.value;
  return out;
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
      const seasonNeedle = season.toLocaleLowerCase().trim();
      const ranking = filterLeaderboard(nodes.map(normalizeRecord), params)
        .filter(r => !seasonNeedle || r.season.toLocaleLowerCase() === seasonNeedle);
      const members = await fetchMetaobjects("perfil_de_miembro");
      const byId = new Map();
      for (const member of members) {
        const fields = fieldMapForMember(member);
        const id = clean(fields.identificador_miembro || fields.identificador_del_miembro);
        if (id) byId.set(id.toLocaleLowerCase(), { id: member.id, handle: member.handle, fields: member.fields });
      }
      const matched = ranking.map(row => {
        const fields = row.fields || {};
        const player = clean(row.player);
        const idField = clean(fields.identificador_miembro || fields.identificador_del_miembro);
        const member = idField ? byId.get(idField.toLocaleLowerCase()) : null;
        return { rank: row.rank, player, memberId: idField || null, matchedMember: Boolean(member), memberHandle: member?.handle || null };
      });
      return send(res, 200, {
        ok: true, season, category, count: ranking.length, ranking,
        titleAssignmentPreview: {
          membersWithId: byId.size,
          matched: matched.filter(x => x.matchedMember).length,
          unmatched: matched.filter(x => !x.matchedMember).map(x => ({ rank: x.rank, player: x.player, memberId: x.memberId })),
          note: "El registro de competición necesita incluir el campo identificador_miembro (por ejemplo avalon001) para asociarlo de forma segura."
        }
      });
    } catch (error) {
      return send(res, 502, { ok: false, error: error.message || "Error consultando el ranking." });
    }
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

        // Reject fuzzy matching: a season name must match exactly before closing.
        const shortCategory = category.includes("·") ? category.split("·").pop().trim() : category;
        const nodes = await fetchMetaobjects("registro_competicion");
        const params = new URLSearchParams({ category: shortCategory });
        const ranking = filterLeaderboard(nodes.map(normalizeRecord), params)
          .filter(r => r.season.toLocaleLowerCase() === season.toLocaleLowerCase());
        if (!ranking.length) {
          return send(res, 409, { ok: false, error: "No hay registros para esa temporada y categoría; no se archivó nada." });
        }

        const members = await fetchMetaobjects("perfil_de_miembro");
        const byId = new Map();
        const memberFieldMaps = new Map();
        for (const member of members) {
          const fields = fieldMapForMember(member);
          const id = clean(fields.identificador_miembro || fields.identificador_del_miembro);
          if (id) {
            const key = id.toLocaleLowerCase();
            if (byId.has(key)) throw new Error("Hay identificadores de miembro duplicados: " + id + ". No se cerró la temporada.");
            byId.set(key, member);
            memberFieldMaps.set(member.id, fields);
          }
        }

        // Safe linking: the competition records need the same permanent ID. Never match on display name.
        const unmatched = [];
        const awards = [];
        const awardTitle = clean(data.title) || (season + " · " + category);
        for (const row of ranking) {
          const fields = row.fields || {};
          const memberId = clean(fields.identificador_miembro || fields.identificador_del_miembro);
          const member = memberId ? byId.get(memberId.toLocaleLowerCase()) : null;
          if (!member) {
            unmatched.push({ rank: row.rank, player: row.player, memberId: memberId || null });
            continue;
          }
          awards.push({ rank: row.rank, player: row.player, memberId, member });
        }
        if (unmatched.length) {
          return send(res, 409, {
            ok: false,
            error: "No se archivó ni cerró la temporada porque hay registros sin un perfil identificable por ID. Añade identificador_miembro a cada registro de competición y vuelve a intentarlo.",
            unmatched: unmatched.slice(0, 50),
            totalUnmatched: unmatched.length
          });
        }

        // Check for a prior archive for this exact season+category before mutating anything.
        const existingArchives = await fetchMetaobjects("avalon_season_archive");
        const alreadyClosed = existingArchives.some(node => {
          const f = fieldMapForMember(node);
          return clean(f.season_name).toLocaleLowerCase() === season.toLocaleLowerCase()
            && clean(f.category).toLocaleLowerCase() === category.toLocaleLowerCase()
            && clean(f.archive_status).toLocaleLowerCase() === "closed";
        });
        if (alreadyClosed) return send(res, 409, { ok: false, error: "Esta temporada y categoría ya están cerradas. No se duplicó el archivo ni se reasignaron títulos." });

        // Create the historical snapshot first; if this fails, profiles remain unchanged.
        const archive = await createSeasonArchive(shopifyQuery, season, category, ranking);
        const granted = [];
        const skipped = [];
        for (const award of awards) {
          const uniqueTitle = awardTitle;
          const result = await updateMemberTitles(shopifyQuery, award.member, uniqueTitle, season + "|" + category);
          (result.updated ? granted : skipped).push({
            rank: award.rank, player: award.player, memberId: award.memberId, title: uniqueTitle,
            reason: result.reason || null
          });
        }
        return send(res, 201, {
          ok: true,
          message: "Temporada archivada y títulos procesados.",
          archive,
          rankingCount: ranking.length,
          titlesGranted: granted.length,
          titlesSkipped: skipped.length,
          granted,
          skipped,
          note: "Los registros originales se conservaron. La asociación usa únicamente identificador_miembro."
        });
      } catch (error) {
        return send(res, 502, { ok: false, error: error.message || "No se pudo cerrar la temporada." });
      }
    });
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin };
