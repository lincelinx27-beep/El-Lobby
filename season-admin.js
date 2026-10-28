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
    throw new Error("ARCHIVO / definición avalon_season_archive: Shopify no confirmó la creación. Revisa si este tipo está reservado a otra app.");
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
    { key: "archive_status", value: "processing" }
  ];
  const result = await shopifyQuery(
    'mutation($handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: {type: "avalon_season_archive", handle: $handle, fields: $fields}) { metaobject { id handle } userErrors { field message } } }',
    { handle, fields }
  );
  const errors = result?.metaobjectCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "));
  if (!result?.metaobjectCreate?.metaobject) {
    throw new Error("ARCHIVO / metaobjectCreate avalon_season_archive: Shopify no confirmó la creación. Comprueba la propiedad del tipo de metaobjeto.");
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
  return String(fields.identificador_de_miembro || fields.identificador_del_miembro || fields.identificador_miembro || "").trim();
}

function existingTitles(raw) {
  return String(raw || "").split(/\s*[|;\n]\s*/).map(v => v.trim()).filter(Boolean);
}

async function setSeasonArchiveStatus(shopifyQuery, archiveId, status) {
  const result = await shopifyQuery(
    'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle } userErrors { field message } } }',
    { id: archiveId, fields: [{ key: "archive_status", value: status }] }
  );
  const errors = result?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  if (!result?.metaobjectUpdate?.metaobject) throw new Error("ARCHIVO / metaobjectUpdate avalon_season_archive: Shopify no confirmó el cambio de estado.");
}

function titleForRank(rank, category, customTitle) {
  if (customTitle) return customTitle;
  const distinction = rank === 1 ? "Campeón" : rank === 2 ? "Subcampeón" : rank === 3 ? "Tercer lugar" : "Puesto " + rank;
  return distinction + " · " + category;
}

async function ensureMemberTitlesDefinition(shopifyQuery) {
  const result = await shopifyQuery(
    'query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }'
  );
  const defs = result?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  let def = defs.find(item => norm(item.type) === norm("perfil_de_miembro"));
  if (!def) def = defs.find(item => norm(item.name).includes("perfil") && norm(item.name).includes("miembro"));
  if (!def?.id) throw new Error("No se encontró la definición Perfil de Miembro. No se modificaron perfiles ni registros.");

  const field = (def.fieldDefinitions || []).find(item => ["titulos_obtenidos", "títulos_obtenidos", "titulos_obtenidos_"].includes(item.key));
  if (!field) throw new Error("Falta el campo Títulos Obtenidos en Perfil de Miembro. Créalo como lista de referencias a metaobjetos (list.metaobject_reference). No se borraron registros.");
  const type = String(field.type?.name || "").toLowerCase();
  if (type !== "list.metaobject_reference") {
    throw new Error("El campo " + field.key + " tiene tipo " + (type || "desconocido") + "; se requiere list.metaobject_reference. No se modificaron perfiles ni registros.");
  }
  return field;
}

async function resolveCatalogTitle(shopifyQuery, requestedTitle) {
  const wanted = String(requestedTitle || "").trim();
  if (!wanted) throw new Error("No se especificó el título a otorgar.");
  const nodes = await (async () => {
    const all = []; let after = null;
    while (all.length < 250) {
      const data = await shopifyQuery(
        'query($after: String) { metaobjects(type: "catalogo_titulos", first: 100, after: $after) { nodes { id handle fields { key value } } pageInfo { hasNextPage endCursor } } }',
        { after }
      );
      const conn = data.metaobjects; all.push(...conn.nodes || []);
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return all;
  })();
  const norm = value => String(value || "").trim().toLocaleLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
  const matches = nodes.filter(node => {
    const name = (node.fields || []).find(field => norm(field.key) === norm("Nombre de Título") || norm(field.key) === norm("nombre_de_titulo") || norm(field.key) === "name");
    return name && norm(name.value) === norm(wanted);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length ? "El catálogo contiene más de una entrada para el título '" + wanted + "'. Corrige los duplicados antes de cerrar." : "No se encontró '" + wanted + "' en Catálogo de Títulos (catalogo_titulos). Añade la entrada y vuelve a intentarlo. No se eliminaron registros.");
  }
  return matches[0];
}

async function updateMemberTitles(shopifyQuery, member, awardTitleMetaobject) {
  const fieldDefinition = await ensureMemberTitlesDefinition(shopifyQuery);
  const key = fieldDefinition.key;
  const raw = String(memberFieldMap(member)[key] || "");
  let refs = [];
  try {
    const parsed = JSON.parse(raw || "[]");
    refs = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    throw new Error("El perfil " + member.handle + " contiene referencias de títulos con formato inválido. No se borraron registros.");
  }
  const titleId = awardTitleMetaobject.id;
  if (refs.includes(titleId)) return { updated: false, reason: "already-awarded" };
  const nextValue = JSON.stringify([...refs, titleId]);
  const result = await shopifyQuery(
    'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }',
    { id: member.id, fields: [{ key, value: nextValue }] }
  );
  const errors = result?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error("TÍTULOS / " + key + " (list.metaobject_reference): " + errors.map(e => e.message).join("; ") + ". No se eliminaron registros de competición.");
  const saved = result?.metaobjectUpdate?.metaobject;
  const savedField = saved?.fields?.find(field => field.key === key);
  let verified = [];
  try { verified = JSON.parse(savedField?.value || "[]"); } catch {}
  if (!saved || !Array.isArray(verified) || !verified.includes(titleId)) {
    throw new Error("Shopify no confirmó la referencia del título para " + member.handle + ". No se eliminaron registros de competición.");
  }
  return { updated: true };
}

async function deleteCompetitionRecord(shopifyQuery, id) {
  const result = await shopifyQuery(
    'mutation($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { field message } } }',
    { id }
  );
  const errors = result?.metaobjectDelete?.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  if (result?.metaobjectDelete?.deletedId !== id) {
    throw new Error("ELIMINACIÓN / metaobjectDelete registro_competicion id=" + id + ": Shopify no confirmó la eliminación.");
  }
}

async function handleSeasonAdmin(req, res, url, deps) {
  const { send, clean, shopifyQuery, fetchMetaobjects, normalizeRecord, filterLeaderboard } = deps;
  if (!url.pathname.startsWith("/api/admin/seasons")) return false;
  const safeSend = (status, payload) => { if (res.writableEnded || res.destroyed) return false; send(res, status, payload); return true; };
  if (!ADMIN_TOKEN) {
    safeSend(503, { ok: false, error: "Falta configurar AVALON_ADMIN_TOKEN en el servidor." });
    return true;
  }
  if (!authorized(req)) {
    safeSend(401, { ok: false, error: "Acceso denegado. Introduce la clave de administrador." });
    return true;
  }

  async function buildPreview(category) {
    const categoryText = category.toLocaleLowerCase();
    const categoryCode = categoryText.includes("grand cross") || categoryText.includes("grandcross") ? "7GC" : categoryText.includes("gremios") ? "7OriginG" : "7Origin";
    const nodes = await fetchMetaobjects("registro_competicion");
    const params = new URLSearchParams({ category: categoryCode });
    const ranking = filterLeaderboard(nodes.map(normalizeRecord), params);
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
        note: "Cada registro de competición debe incluir identificador_de_miembro (ej. avalon001). No se asocian perfiles por nombre."
      }
    };
  }

  if (req.method === "GET" && url.pathname === "/api/admin/seasons/preview") {
    try {
      const category = clean(url.searchParams.get("category")) || "Origin · Jefes";
      const preview = await buildPreview(category);
      return send(res, 200, { ok: true, category, count: preview.ranking.length, ranking: preview.ranking, titleAssignmentPreview: preview.titleAssignmentPreview });
    } catch (error) {
      safeSend(502, { ok: false, error: error.message || "Error consultando el ranking." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/seasons/close") {
    try {
      const body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", chunk => {
          raw += chunk;
          if (raw.length > 100000) {
            reject(new Error("El cuerpo de la solicitud supera el límite permitido."));
            req.destroy();
          }
        });
        req.on("end", () => resolve(raw));
        req.on("error", reject);
      });
      const data = JSON.parse(body || "{}");
        const category = clean(data.category) || "Origin · Jefes";
        const archiveName = "Única";
        const preview = await buildPreview(category);
        const ranking = preview.ranking;
        if (!ranking.length) return safeSend(409, { ok: false, error: "No hay registros para la categoría elegida; no se archivó ni se eliminó nada." });
        if (preview.titleAssignmentPreview.duplicateMemberIds.length) {
          return safeSend(409, { ok: false, error: "Hay IDs de miembro duplicados. No se archivó ni se asignaron títulos.", duplicateMemberIds: preview.titleAssignmentPreview.duplicateMemberIds });
        }
        if (preview.titleAssignmentPreview.unmatched.length) {
          return safeSend(409, { ok: false, error: "Hay registros sin un perfil identificable por ID. Añade identificador_de_miembro al registro de competición y vuelve a intentarlo.", unmatched: preview.titleAssignmentPreview.unmatched.slice(0, 50), totalUnmatched: preview.titleAssignmentPreview.unmatched.length });
        }

        // This flow uses only the merchant-created member and competition metaobjects.
        // Do not create/update the app-reserved archive definition: Shopify rejects that type.
        const members = await fetchMetaobjects("perfil_de_miembro");
        const byId = new Map();
        for (const member of members) {
          const id = memberIdentifier(memberFieldMap(member));
          if (id) byId.set(id.toLocaleLowerCase(), member);
        }

        const awards = [];
        for (const row of ranking) {
          const memberId = memberIdentifier(row.fields || {});
          const member = byId.get(memberId.toLocaleLowerCase());
          const title = clean(data.title) || titleForRank(row.rank, category, "");
          const titleMetaobject = await resolveCatalogTitle(shopifyQuery, title);
          console.log("[Avalon admin] etapa=titulo rank=" + row.rank + " member=" + member.handle + " title=" + titleMetaobject.handle);
          const result = await updateMemberTitles(shopifyQuery, member, titleMetaobject);
          awards.push({ rank: row.rank, player: row.player, memberId, title, titleId: titleMetaobject.id, updated: result.updated, reason: result.reason || null });
        }

        // Delete only the competition records selected for this category, after all titles were saved.
        let deletedRecords = 0;
        for (const row of ranking) {
          console.log("[Avalon admin] etapa=eliminar registro=" + row.id);
          await deleteCompetitionRecord(shopifyQuery, row.id);
          deletedRecords++;
        }

        return safeSend(201, {
          ok: true,
          message: "Títulos asignados y registros de la categoría procesada eliminados.",
          rankingCount: ranking.length,
          deletedRecords,
          titlesGranted: awards.filter(award => award.updated).length,
          titlesAlreadyPresent: awards.filter(award => !award.updated).length,
          awards,
          note: "Se eliminaron solo los registros incluidos en la categoría procesada; los títulos se asignaron por identificador permanente. El proceso no crea ni modifica definiciones de metaobjetos."
        });
    } catch (error) {
      safeSend(502, { ok: false, error: error.message || "No se pudo procesar la categoría." });
    }
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin };
