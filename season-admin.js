// Avalon Season Admin — protected archive routes
const ADMIN_TOKEN = process.env.AVALON_ADMIN_TOKEN || "";
let memberIdAllocationLock = Promise.resolve();

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

async function getNextMemberId(shopifyQuery, members) {
  // Process-local queue reduces collisions inside one node process. The reservation metaobject
  // handle is the cross-instance uniqueness guard: Shopify accepts only one reservation per ID.
  const previous = memberIdAllocationLock;
  let release;
  memberIdAllocationLock = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const counterDefinition = await shopifyQuery('query { metaobjectDefinitionByType(type: "avalon_member_id_counter") { id type fieldDefinitions { key type { name } } } }');
    if (!counterDefinition?.metaobjectDefinitionByType) {
      const created = await shopifyQuery('mutation { metaobjectDefinitionCreate(definition: { type: "avalon_member_id_counter", name: "Avalon Member ID Counter", fieldDefinitions: [{ key: "last_id", name: "Last assigned ID", type: "number_integer" }] }) { metaobjectDefinition { id type } userErrors { field message } } }');
      const errors = created?.metaobjectDefinitionCreate?.userErrors || [];
      if (errors.length || !created?.metaobjectDefinitionCreate?.metaobjectDefinition) {
        throw new Error("No se pudo crear la definición permanente avalon_member_id_counter: " + errors.map(e => e.message).join("; "));
      }
    } else {
      const field = (counterDefinition.metaobjectDefinitionByType.fieldDefinitions || []).find(item => item.key === "last_id");
      if (field && String(field.type?.name || "").toLowerCase() !== "number_integer") {
        throw new Error("El campo last_id de avalon_member_id_counter debe ser Número entero (number_integer).");
      }
    }

    const reservationDefinition = await shopifyQuery('query { metaobjectDefinitionByType(type: "avalon_member_id_reservation") { id type fieldDefinitions { key type { name } } } }');
    if (!reservationDefinition?.metaobjectDefinitionByType) {
      const created = await shopifyQuery('mutation { metaobjectDefinitionCreate(definition: { type: "avalon_member_id_reservation", name: "Avalon Member ID Reservation", fieldDefinitions: [{ key: "member_id", name: "Member ID", type: "single_line_text_field" }] }) { metaobjectDefinition { id type } userErrors { field message } } }');
      const errors = created?.metaobjectDefinitionCreate?.userErrors || [];
      if (errors.length || !created?.metaobjectDefinitionCreate?.metaobjectDefinition) {
        throw new Error("No se pudo crear la definición de reservas permanentes avalon_member_id_reservation: " + errors.map(e => e.message).join("; "));
      }
    }

    const records = await shopifyQuery('query { metaobjects(type: "avalon_member_id_counter", first: 50) { nodes { id handle fields { key value } } } }');
    const counters = records?.metaobjects?.nodes || [];
    const counterMatches = counters.filter(item => item.handle === "avalon-member-id-counter");
    if (counterMatches.length > 1) throw new Error("Hay más de un registro contador Avalon con el handle avalon-member-id-counter.");
    let counter = counterMatches[0] || counters[0] || null;
    let last = Number(counter?.fields?.find(field => field.key === "last_id")?.value || 0);
    if (!Number.isSafeInteger(last) || last < 0) throw new Error("El valor last_id del contador Avalon no es un entero válido.");

    for (const member of members || []) {
      const id = memberIdentifier(memberFieldMap(member));
      const match = id.match(/(\d+)$/);
      if (match) last = Math.max(last, Number(match[1]));
    }
    if (!Number.isSafeInteger(last) || last >= 999999) throw new Error("Se agotaron los identificadores disponibles.");

    // Reserve each candidate using a unique handle before advancing the watermark. If two
    // server instances race for the same ID, only one reservation can succeed.
    let next = last + 1;
    let reservation = null;
    while (next <= 999999) {
      const memberId = String(next).padStart(3, "0");
      const handle = "member-" + memberId;
      const existing = await shopifyQuery(
        'query($type: String!, $handle: String!) { metaobjectByHandle(type: $type, handle: $handle) { id handle } }',
        { type: "avalon_member_id_reservation", handle }
      );
      if (existing?.metaobjectByHandle) {
        next++;
        continue;
      }
      const created = await shopifyQuery(
        'mutation($handle: String!, $memberId: String!) { metaobjectCreate(metaobject: { type: "avalon_member_id_reservation", handle: $handle, fields: [{ key: "member_id", value: $memberId }] }) { metaobject { id handle } userErrors { field message } } }',
        { handle, memberId }
      );
      const errors = created?.metaobjectCreate?.userErrors || [];
      if (errors.length || !created?.metaobjectCreate?.metaobject) {
        const message = errors.map(error => error.message).join("; ");
        if (/handle.*(taken|exist|already)|already.*handle|unique/i.test(message)) {
          next++;
          continue;
        }
        throw new Error("No se pudo reservar el identificador " + memberId + ": " + (message || "Shopify no confirmó la reserva."));
      }
      reservation = created.metaobjectCreate.metaobject;
      break;
    }
    if (!reservation) throw new Error("Se agotaron los identificadores disponibles.");
    const memberId = String(next).padStart(3, "0");

    if (counter) {
      const update = await shopifyQuery(
        'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id fields { key value } } userErrors { field message } } }',
        { id: counter.id, fields: [{ key: "last_id", value: String(next) }] }
      );
      const errors = update?.metaobjectUpdate?.userErrors || [];
      if (errors.length || !update?.metaobjectUpdate?.metaobject) {
        // Reservation remains durable; the next allocation will skip it even if watermark update failed.
        throw new Error("El ID " + memberId + " quedó reservado, pero no se pudo actualizar last_id. No se reutilizará; revisa el contador y vuelve a intentar.");
      }
    } else {
      const created = await shopifyQuery(
        'mutation($handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: { type: "avalon_member_id_counter", handle: $handle, fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }',
        { handle: "avalon-member-id-counter", fields: [{ key: "last_id", value: String(next) }] }
      );
      const errors = created?.metaobjectCreate?.userErrors || [];
      if (errors.length || !created?.metaobjectCreate?.metaobject) {
        throw new Error("El ID " + memberId + " quedó reservado, pero no se pudo crear el registro contador. No se reutilizará; revisa Shopify y vuelve a intentar.");
      }
    }
    return memberId;
  } finally {
    release();
  }
}

async function getNextMemberIdForPreview(shopifyQuery, members) {
  const definition = await shopifyQuery('query { metaobjectDefinitionByType(type: "avalon_member_id_counter") { id type fieldDefinitions { key type { name } } } }');
  let last = 0;
  if (definition?.metaobjectDefinitionByType) {
    const counterField = (definition.metaobjectDefinitionByType.fieldDefinitions || []).find(field => field.key === "last_id");
    if (counterField && String(counterField.type?.name || "").toLowerCase() !== "number_integer") {
      throw new Error("El campo last_id de avalon_member_id_counter debe ser Número entero (number_integer).");
    }
  }
  const records = await shopifyQuery('query { metaobjects(type: "avalon_member_id_counter", first: 50) { nodes { id handle fields { key value } } } }');
  const counters = records?.metaobjects?.nodes || [];
  if (counters.filter(item => item.handle === "avalon-member-id-counter").length > 1) {
    throw new Error("Hay más de un registro contador Avalon con el handle avalon-member-id-counter. Deja uno solo antes de continuar.");
  }
  const counter = counters.find(item => item.handle === "avalon-member-id-counter") || counters[0] || null;
  last = Number(counter?.fields?.find(field => field.key === "last_id")?.value || 0);
  if (!Number.isSafeInteger(last) || last < 0) throw new Error("El valor last_id del contador Avalon no es un entero válido.");
  for (const member of members || []) {
    const id = memberIdentifier(memberFieldMap(member));
    const match = id.match(/(\d+)$/);
    if (match) last = Math.max(last, Number(match[1]));
  }
  if (!Number.isSafeInteger(last)) throw new Error("El valor máximo de IDs existentes no es válido.");
  // Preview remains read-only but skips IDs already reserved even when the watermark is stale.
  while (last < 999999) {
    const candidate = String(last + 1).padStart(3, "0");
    const check = await shopifyQuery(
      'query($type: String!, $handle: String!) { metaobjectByHandle(type: $type, handle: $handle) { id handle } }',
      { type: "avalon_member_id_reservation", handle: "member-" + candidate }
    );
    if (!check?.metaobjectByHandle) return candidate;
    last++;
  }
  throw new Error("Se agotaron los identificadores disponibles.");
}

function titleForRank(rank, category, customTitle) {
  if (customTitle) return customTitle;
  const distinction = rank === 1 ? "Campeón" : rank === 2 ? "Subcampeón" : rank === 3 ? "Tercer lugar" : "Puesto " + rank;
  return distinction + " · " + category;
}

async function validateSeasonSetup(shopifyQuery, ranking) {
  const data = await shopifyQuery('query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }');
  const defs = data?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const findDef = (type, terms) => defs.find(item => norm(item.type) === norm(type)) || defs.find(item => terms.every(term => norm(item.name).includes(norm(term))));
  const catalog = findDef("catalogo_de_titulos", ["catalogo", "titulo"]);
  const earned = findDef("titulo_obtenido", ["titulo", "obtenido"]);
  const history = findDef("historial_de_temporadas", ["historial", "temporada"]);
  if (!catalog) throw new Error("Falta la definición catalogo_de_titulos.");
  if (!earned) throw new Error("Falta la definición titulo_obtenido.");
  if (!history) throw new Error("Falta la definición historial_de_temporadas.");
  const catalogEntries = await resolveCatalogTitlesForValidation(shopifyQuery);
  const titles = [...new Set((ranking || []).map(row => titleForRank(row.rank, row.category || "", "")))];
  // Validate the catalog labels used by the current category before writing history or profiles.
  const category = (ranking || [])[0]?.category || "";
  const requiredTitles = (ranking || []).map(row => titleForRank(row.rank, category, ""));
  const missing = requiredTitles.filter(title => !catalogEntries.some(entry => norm(entry.name) === norm(title)));
  if (missing.length) throw new Error("Faltan títulos en catalogo_de_titulos para esta categoría: " + [...new Set(missing)].join(", ") + ". No se modificó ningún perfil ni registro de competición.");
  return { catalog, earned, history };
}

async function resolveCatalogTitlesForValidation(shopifyQuery) {
  const items = [];
  let after = null;
  while (items.length < 250) {
    const data = await shopifyQuery(
      'query($after: String) { metaobjects(type: "catalogo_de_titulos", first: 100, after: $after) { nodes { id handle fields { key value } } pageInfo { hasNextPage endCursor } } }',
      { after }
    );
    const connection = data?.metaobjects;
    if (!connection) throw new Error("Shopify no devolvió el catálogo de títulos.");
    items.push(...(connection.nodes || []));
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo?.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  const norm = value => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  return items.map(node => {
    const field = (node.fields || []).find(item => ["nombre", "nombre_de_titulo", "nombre_del_titulo", "titulo", "titulo_del_catalogo", "name", "title"].includes(norm(item.key)));
    return { id: node.id, name: field?.value || "" };
  });
}

async function ensureMemberTitlesDefinition(shopifyQuery) {
  const result = await shopifyQuery(
    'query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }'
  );
  const defs = result?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  let def = defs.find(item => norm(item.type) === norm("perfil_de_miembros"));
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
  const all = []; let after = null;
  while (all.length < 250) {
    const data = await shopifyQuery(
      'query($after: String) { metaobjects(type: "catalogo_de_titulos", first: 100, after: $after) { nodes { id handle fields { key value } } pageInfo { hasNextPage endCursor } } }',
      { after }
    );
    const conn = data.metaobjects; all.push(...conn.nodes || []);
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  const norm = value => String(value || "").trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const matches = all.filter(node => {
    const name = (node.fields || []).find(field =>
      ["nombre", "nombre_de_titulo", "nombre_del_titulo", "titulo", "titulo_del_catalogo", "name", "title"].includes(norm(field.key))
    );
    return name && norm(name.value) === norm(wanted);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "El catálogo contiene más de una entrada para el título '" + wanted + "'. Corrige los duplicados antes de cerrar."
      : "No se encontró '" + wanted + "' en Catálogo de Títulos (catalogo_de_titulos). Revisa el campo Nombre de la definición y la entrada del catálogo. No se eliminaron registros.");
  }
  return matches[0];
}
async function createEarnedTitleRecord(shopifyQuery, member, catalogTitle, row, category, seasonName) {
  const data = await shopifyQuery('query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }');
  const defs = data?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const def = defs.find(item => norm(item.type) === norm("titulo_obtenido")) || defs.find(item => norm(item.name).includes("titulo") && norm(item.name).includes("obtenido"));
  if (!def?.id) throw new Error("No se encontró la definición Título Obtenido; no se eliminaron registros de competición.");
  const fieldsDef = def.fieldDefinitions || [];
  const find = aliases => fieldsDef.find(field => aliases.includes(norm(field.key)) || aliases.includes(norm(field.name)));
  const titleRef = find(["titulo", "titulobase", "titulodecatalogo", "titulodelcatalogo", "referenciaaltitulo"]);
  const memberRef = find(["miembro", "perfil", "perfilmiembro", "miembroreferido"]);
  const memberIdField = find(["identificadordemiembro", "identificadormiembro"]);
  const memberNameField = find(["nombredelmiembro", "nombrede miembro", "miembro"]);
  const guildField = find(["gremio", "nombredelgremio"]);
  const gameField = find(["juego", "juegoprincipal"]);
  const categoryField = find(["categoria"]);
  const rankField = find(["puesto", "posicion", "ranking", "lugar"]);
  const seasonField = find(["temporada", "nombredelatemporada"]);
  const dateField = find(["fecha", "fechadeobtencion", "fechaobtencion"]);
  const fields = [];
  if (titleRef) fields.push({ key: titleRef.key, value: catalogTitle.id });
  if (memberRef) fields.push({ key: memberRef.key, value: member.id });
  if (memberIdField) fields.push({ key: memberIdField.key, value: memberIdentifier(memberFieldMap(member)) });
  if (memberNameField) fields.push({ key: memberNameField.key, value: clean(row.player) });
  if (guildField) fields.push({ key: guildField.key, value: clean(row.guild) });
  if (gameField) fields.push({ key: gameField.key, value: category.toLowerCase().includes("grand cross") ? "Grand Cross" : "Origin" });
  if (categoryField) fields.push({ key: categoryField.key, value: category });
  if (rankField) fields.push({ key: rankField.key, value: String(row.rank) });
  if (seasonField) fields.push({ key: seasonField.key, value: seasonName });
  if (dateField) fields.push({ key: dateField.key, value: new Date().toISOString() });
  if (!titleRef && !memberIdField && !memberRef) throw new Error("Título Obtenido no tiene campos compatibles para guardar título y miembro.");
  const seasonSlug = String(seasonName || category).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  const categorySlug = String(category).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const memberSlug = memberIdentifier(memberFieldMap(member)).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const handle = ("titulo-" + memberSlug + "-" + categorySlug + "-" + seasonSlug + "-r" + row.rank).slice(0, 250).replace(/-+$/g, "");
  const existing = await shopifyQuery(
    'query($type: String!, $handle: String!) { metaobjectByHandle(type: $type, handle: $handle) { id handle fields { key value } } }',
    { type: def.type, handle }
  );
  if (existing?.metaobjectByHandle) return existing.metaobjectByHandle;
  const created = await shopifyQuery('mutation($type: String!, $handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: { type: $type, handle: $handle, fields: $fields }) { metaobject { id handle fields { key value } } userErrors { field message } } }', { type: def.type, handle, fields });
  const errors = created?.metaobjectCreate?.userErrors || [];
  if (errors.length || !created?.metaobjectCreate?.metaobject) throw new Error("No se pudo guardar el título obtenido para " + member.handle + ": " + errors.map(e => e.message).join("; "));
  return created.metaobjectCreate.metaobject;
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

async function saveSeasonHistory(shopifyQuery, seasonName, category, ranking) {
  const data = await shopifyQuery('query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }');
  const defs = data?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const def = defs.find(item => norm(item.type) === norm("historial_de_temporadas")) || defs.find(item => norm(item.name).includes("historial") && norm(item.name).includes("temporada"));
  if (!def?.id) throw new Error("No se encontró Historial de Temporadas. No se eliminaron registros de competición.");
  const fieldDefs = def.fieldDefinitions || [];
  const keyFor = aliases => fieldDefs.find(field => aliases.includes(norm(field.key)) || aliases.includes(norm(field.name)))?.key;
  const nameKey = keyFor(["temporada", "nombretemporada", "nombredelatemporada", "nombre"]);
  const categoryKey = keyFor(["categoria", "juego", "juegoprincipal"]);
  const dateKey = keyFor(["fechadecierre", "fechacierre", "fecha"]);
  const rankingKey = keyFor(["ranking", "rankingjson", "resultados", "clasificacion", "clasificacionfinal"]);
  const statusKey = keyFor(["estado", "status"]);
  const fields = [];
  if (nameKey) fields.push({ key: nameKey, value: seasonName });
  if (categoryKey) fields.push({ key: categoryKey, value: category });
  if (dateKey) fields.push({ key: dateKey, value: new Date().toISOString() });
  if (rankingKey) fields.push({ key: rankingKey, value: JSON.stringify(ranking) });
  if (statusKey) fields.push({ key: statusKey, value: "cerrada" });
  if (!nameKey || !rankingKey) throw new Error("Historial de Temporadas debe tener campos de temporada y ranking/resultados para archivar de forma segura.");
  const seasonSlug = String(seasonName).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 180);
  const categorySlug = String(category).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const handle = ("temporada-" + seasonSlug + "-" + categorySlug).slice(0, 250).replace(/-+$/g, "");
  const existing = await shopifyQuery(
    'query($type: String!, $handle: String!) { metaobjectByHandle(type: $type, handle: $handle) { id handle fields { key value } } }',
    { type: def.type, handle }
  );
  if (existing?.metaobjectByHandle) {
    const update = await shopifyQuery(
      'mutation($id: ID!, $fields: [MetaobjectFieldInput!]!) { metaobjectUpdate(id: $id, metaobject: { fields: $fields }) { metaobject { id handle } userErrors { field message } } }',
      { id: existing.metaobjectByHandle.id, fields }
    );
    const updateErrors = update?.metaobjectUpdate?.userErrors || [];
    if (updateErrors.length || !update?.metaobjectUpdate?.metaobject) throw new Error("No se pudo actualizar el histórico de la temporada existente: " + updateErrors.map(e => e.message).join("; "));
    return update.metaobjectUpdate.metaobject;
  }
  const created = await shopifyQuery('mutation($type: String!, $handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: { type: $type, handle: $handle, fields: $fields }) { metaobject { id handle } userErrors { field message } } }', { type: def.type, handle, fields });
  const errors = created?.metaobjectCreate?.userErrors || [];
  if (errors.length || !created?.metaobjectCreate?.metaobject) throw new Error("No se pudo guardar Historial de Temporadas: " + errors.map(e => e.message).join("; "));
  return created.metaobjectCreate.metaobject;
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

  async function memberDefinition(shopifyQuery) {
  const data = await shopifyQuery('query { metaobjectDefinitions(first: 250) { nodes { id type name fieldDefinitions { key name type { name } } } } }');
  const defs = data?.metaobjectDefinitions?.nodes || [];
  const norm = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const def = defs.find(item => norm(item.type) === norm("perfil_de_miembros")) || defs.find(item => norm(item.name).includes("perfil") && norm(item.name).includes("miembro"));
  if (!def) throw new Error("No se encontró la definición Perfil de Miembros.");
  return def;
}


async function createMemberProfile(shopifyQuery, members, row, category) {
  const def = await memberDefinition(shopifyQuery);
  const fieldsDef = def.fieldDefinitions || [];
  const findKey = (...aliases) => {
    const wanted = new Set(aliases.map(alias => String(alias).toLowerCase().replace(/[^a-z0-9]/g, "")));
    const item = fieldsDef.find(field => wanted.has(String(field.key || "").toLowerCase().replace(/[^a-z0-9]/g, "")) || wanted.has(String(field.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")));
    return item?.key || null;
  };
  const idKey = findKey("identificador_de_miembro", "identificador_del_miembro", "identificador_miembro");
  const nameKey = findKey("nombre_del_miembro", "nombre_de_miembro", "nombre", "miembro");
  const guildKey = findKey("gremio", "nombre_del_gremio", "nombre_de_gremio");
  const gameKey = findKey("juego", "juego_principal");
  const titlesKey = findKey("titulos_obtenidos", "titulos_obtenidos_");
  const titlesDef = fieldsDef.find(field => field.key === titlesKey);
  if (!idKey || !nameKey) throw new Error("Perfil de Miembros necesita campos Nombre del Miembro e Identificador de Miembro para crear perfiles automáticamente.");
  if (titlesKey && String(titlesDef?.type?.name || "").toLowerCase() !== "list.metaobject_reference") {
    throw new Error("El campo Títulos Obtenidos del perfil debe ser list.metaobject_reference para enlazar registros de títulos obtenidos. Corrige la definición antes de crear perfiles.");
  }
  const id = await getNextMemberId(shopifyQuery, members);
  const values = [
    { key: idKey, value: id },
    { key: nameKey, value: clean(row.player) || "Miembro Avalon" }
  ];
  if (guildKey) values.push({ key: guildKey, value: clean(row.guild) });
  if (gameKey) values.push({ key: gameKey, value: category.toLowerCase().includes("grand cross") ? "Grand Cross" : "Origin" });
  // An unset list-reference field is already empty; do not send a JSON string as if it were a reference list.
  const handle = "miembro-" + id;
  const result = await shopifyQuery(
    'mutation($type: String!, $handle: String!, $fields: [MetaobjectFieldInput!]!) { metaobjectCreate(metaobject: {type: $type, handle: $handle, fields: $fields}) { metaobject { id handle fields { key value } } userErrors { field message } } }',
    { type: def.type, handle, fields: values }
  );
  const errors = result?.metaobjectCreate?.userErrors || [];
  if (errors.length) throw new Error("No se pudo crear el perfil " + id + ": " + errors.map(e => e.message).join("; "));
  const created = result?.metaobjectCreate?.metaobject;
  if (!created) throw new Error("Shopify no confirmó la creación del perfil " + id + ".");
  members.push(created);
  return created;
}

async function buildPreview(category) {
    const categoryText = category.toLocaleLowerCase();
    const categoryCode = categoryText.includes("grand cross") || categoryText.includes("grandcross") ? "7GC" : categoryText.includes("gremios") ? "7OriginG" : "7Origin";
    const nodes = await fetchMetaobjects("registro_de_competicion");
    const params = new URLSearchParams({ category: categoryCode });
    const ranking = filterLeaderboard(nodes.map(normalizeRecord), params);
    const memberNodes = await fetchMetaobjects("perfil_de_miembros");
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
      return { rank: row.rank, player: row.player, guild: row.guild || "", memberId: memberId || null, matchedMember: Boolean(member), memberHandle: member?.handle || null, willCreateProfile: !member };
    });
    return {
      ranking,
      titleAssignmentPreview: {
        membersWithId: membersById.size,
        matched: assignments.filter(item => item.matchedMember).length,
        unmatched: assignments.filter(item => !item.matchedMember).map(({ rank, player, guild, memberId }) => ({ rank, player, guild, memberId })),
        profilesToCreate: assignments.filter(item => !item.matchedMember).length,
        duplicateMemberIds: [...new Set(duplicateIds)],
        note: "Los registros con identificador existente se enlazan por ID; cuando el ID no existe se creará un perfil con el siguiente identificador libre. Nunca se empareja por nombre."
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
        // Validate catalog and required metaobject definitions before making any changes.
        await validateSeasonSetup(shopifyQuery, ranking);
        // Existing IDs must map to profiles; new profiles are only for rows without an ID.
        const rowIds = ranking.map(row => memberIdentifier(row.fields || "")).filter(Boolean).map(id => id.toLocaleLowerCase());
        if (new Set(rowIds).size !== rowIds.length) {
          return safeSend(409, { ok: false, error: "El ranking contiene identificadores de miembro repetidos. No se archivó ni se procesó nada." });
        }

        // Persist the complete ranking to Historial de Temporadas before mutating member profiles.
        const history = await saveSeasonHistory(shopifyQuery, clean(data.seasonName) || category + " · " + new Date().toLocaleDateString("es-MX"), category, ranking);
        const members = await fetchMetaobjects("perfil_de_miembros");
        const byId = new Map();
        for (const member of members) {
          const id = memberIdentifier(memberFieldMap(member));
          if (id) {
            const key = id.toLocaleLowerCase();
            if (byId.has(key)) return safeSend(409, { ok: false, error: "Se detectó un identificador duplicado en perfiles. Corrige el duplicado antes de cerrar.", duplicateId: id });
            byId.set(key, member);
          }
        }

        const awards = [];
        for (const row of ranking) {
          let memberId = memberIdentifier(row.fields || {});
          let member = memberId ? byId.get(memberId.toLocaleLowerCase()) : null;
          if (!member) {
            if (memberId) {
              throw new Error("El ranking trae el identificador " + memberId + " para " + clean(row.player) + ", pero no existe ese perfil. Corrige el ID del registro o crea el perfil correspondiente antes de cerrar; no se asignó otro ID automáticamente.");
            }
            const existingByName = members.filter(candidate => {
              const fields = memberFieldMap(candidate);
              return String(fields.nombre_del_miembro || fields.nombre_de_miembro || fields.nombre || "").trim().toLocaleLowerCase() === clean(row.player).toLocaleLowerCase();
            });
            if (existingByName.length > 0) {
              throw new Error("Ya existe un perfil con el nombre " + clean(row.player) + " pero el registro del ranking no tiene ID. Añade el identificador correcto al registro; no se creará un perfil duplicado.");
            }
            member = await createMemberProfile(shopifyQuery, members, row, category);
            memberId = memberIdentifier(memberFieldMap(member));
            byId.set(memberId.toLocaleLowerCase(), member);
          }
          const title = clean(data.title) || titleForRank(row.rank, category, "");
          const titleMetaobject = await resolveCatalogTitle(shopifyQuery, title);
          console.log("[Avalon admin] etapa=titulo rank=" + row.rank + " member=" + member.handle + " title=" + titleMetaobject.handle);
          const earnedTitle = await createEarnedTitleRecord(shopifyQuery, member, titleMetaobject, row, category, clean(data.seasonName) || category);
          const result = await updateMemberTitles(shopifyQuery, member, earnedTitle);
          awards.push({ rank: row.rank, player: row.player, memberId, title, catalogTitleId: titleMetaobject.id, earnedTitleId: earnedTitle.id, updated: result.updated, reason: result.reason || null });
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
          message: "Ranking guardado en Historial de Temporadas, títulos asignados y registros de la categoría procesada eliminados.",
          historyId: history.id,
          rankingCount: ranking.length,
          deletedRecords,
          titlesGranted: awards.filter(award => award.updated).length,
          titlesAlreadyPresent: awards.filter(award => !award.updated).length,
          awards,
          note: "Se eliminaron solo los registros incluidos en la categoría procesada; los títulos se asignaron por identificador permanente. La definición y el registro del contador se crean automáticamente cuando hacen falta."
        });
    } catch (error) {
      safeSend(502, { ok: false, error: error.message || "No se pudo procesar la categoría." });
    }
    return true;
  }

  send(res, 404, { ok: false, error: "Ruta de administración no encontrada." });
  return true;
}

module.exports = { handleSeasonAdmin, getNextMemberId, getNextMemberIdForPreview };
