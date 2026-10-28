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
  return String(raw || "").split(/\\s*[|;\\n]\\s*/).map(v => v.trim()).filter(Boolean);
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

async function updateMemberTitles(shopifyQuery, member, awardTitle) {
  const fields = memberFieldMap(member);
  const fieldKey = ["titulos_obtenidos", "títulos_obtenidos", "titulos_obtenidos_", "títulos_obtenidos_"].find(key => fields[key] !== undefined);
  if (!fieldKey) throw new Error("TÍTULOS / perfil_de_miembro/" + member.handle + ": no se encontró la clave compatible del campo Títulos Obtenidos. Campos recibidos: " + Object.keys(fields).join(", "));

  const definition = await shopifyQuery('query { metaobjectDefinitionByType(type: "perfil_de_miembro") { fieldDefinitions { key type { name } } } }');
  const fieldDefinition = (definition?.metaobjectDefinitionByType?.fieldDefinitions || []).find(field => field.key === fieldKey);
  const isList = String(fieldDefinition?.type?.name || "").startsWith("list.");
  let titles;
  const raw = fields[fieldKey] || "";
  if (isList) {
    try {
      const parsed = JSON.parse(raw || "[]");
      titles = Array.isArray(parsed) ? parsed.map(value => String(value).trim()).filter(Boolean) : existingTitles(raw);
    } catch {
      titles = existingTitles(raw);
    }
  } else {
    titles = existingTitles(raw);
  }

  if (titles.some(title => title.toLocaleLowerCase() === awardTitle.toLocaleLowerCase())) {
    return { updated: false, reason: "already-awarded" };
  }

  const nextValue = isList ? JSON.stringify([...titles, awardTitle]) : [...titles, awardTitle].join(" | ");
  const result = await shopifyQuery(
    'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }',
    { id: member.id, fields: [{ key: fieldKey, value: nextValue }] }
  );
  const errors = result?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  if (!result?.metaobjectUpdate?.metaobject) throw new Error("TÍTULOS / metaobjectUpdate perfil_de_miembro/" + member.handle + ": Shopify no confirmó la actualización.");
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
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const category = clean(data.category) || "Origin · Jefes";
        const archiveName = "Única";
        const preview = await buildPreview(category);
        const ranking = preview.ranking;
        if (!ranking.length) return send(res, 409, { ok: false, error: "No hay registros para la categoría elegida; no se archivó ni se eliminó nada." });
        if (preview.titleAssignmentPreview.duplicateMemberIds.length) {
          return send(res, 409, { ok: false, error: "Hay IDs de miembro duplicados. No se archivó ni se asignaron títulos.", duplicateMemberIds: preview.titleAssignmentPreview.duplicateMemberIds });
        }
        if (preview.titleAssignmentPreview.unmatched.length) {
          return send(res, 409, { ok: false, error: "Hay registros sin un perfil identificable por ID. Añade identificador_de_miembro al registro de competición y vuelve a intentarlo.", unmatched: preview.titleAssignmentPreview.unmatched.slice(0, 50), totalUnmatched: preview.titleAssignmentPreview.unmatched.length });
        }

        const archives = await fetchMetaobjects("avalon_season_archive");
        const matchingArchive = archives.find(node => {
          const fields = memberFieldMap(node);
          return clean(fields.category).toLocaleLowerCase() === category.toLocaleLowerCase();
        });
        if (matchingArchive && clean(memberFieldMap(matchingArchive).archive_status).toLocaleLowerCase() === "closed") {
          return send(res, 409, { ok: false, error: "Esta categoría ya fue procesada. No se duplicaron títulos ni se borraron registros." });
        }

        const members = await fetchMetaobjects("perfil_de_miembro");
        const byId = new Map();
        for (const member of members) {
          const id = memberIdentifier(memberFieldMap(member));
          if (id) byId.set(id.toLocaleLowerCase(), member);
        }

        // Reuse an interrupted processing archive so a retry won't create duplicates.
        console.log("[Avalon admin] etapa=archivo category=" + category + " registros=" + ranking.length);
        const archive = matchingArchive || await createSeasonArchive(shopifyQuery, archiveName, category, ranking);
        await setSeasonArchiveStatus(shopifyQuery, archive.id, "processing");
        const awards = [];
        try {
          for (const row of ranking) {
            const memberId = memberIdentifier(row.fields || {});
            const member = byId.get(memberId.toLocaleLowerCase());
            const title = titleForRank(row.rank, category, clean(data.title));
            console.log("[Avalon admin] etapa=titulo rank=" + row.rank + " member=" + member.handle);
            const result = await updateMemberTitles(shopifyQuery, member, title);
            awards.push({ rank: row.rank, player: row.player, memberId, title, updated: result.updated, reason: result.reason || null });
          }
          await setSeasonArchiveStatus(shopifyQuery, archive.id, "closed");
        } catch (awardError) {
          // The archive remains marked processing so a safe retry can skip already-awarded titles.
          throw new Error("FALLÓ LA ASIGNACIÓN DE TÍTULOS. El archivo quedó en processing; no se han eliminado registros. Detalle: " + awardError.message);
        }

        let deletedRecords = 0;
        try {
          for (const row of ranking) {
            console.log("[Avalon admin] etapa=eliminar registro=" + row.id);
            await deleteCompetitionRecord(shopifyQuery, row.id);
            deletedRecords++;
          }
        } catch (deleteError) {
          await setSeasonArchiveStatus(shopifyQuery, archive.id, "processing");
          throw new Error("FALLÓ LA ELIMINACIÓN después de guardar histórico y títulos (" + deletedRecords + "/" + ranking.length + "). No vuelvas a ejecutar; conserva los registros restantes. Detalle: " + deleteError.message);
        }

        return send(res, 201, {
          ok: true,
          message: "Ranking archivado, títulos asignados y registros procesados eliminados.",
          archive: { id: archive.id, handle: archive.handle, status: "closed" },
          rankingCount: ranking.length,
          deletedRecords,
          titlesGranted: awards.filter(award => award.updated).length,
          titlesAlreadyPresent: awards.filter(award => !award.updated).length,
          awards,
          note: "El histórico conserva el ranking. Se eliminaron solo los registros incluidos en la categoría procesada; los títulos se asignaron por identificador permanente."
        });
      } catch (error) {
        safeSend(502, { ok: false, error: error.message || "No se pudo cerrar la temporada." });
      }
    });
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin };
