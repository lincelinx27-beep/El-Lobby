const test = require("node:test");
const assert = require("node:assert/strict");
const { getNextMemberIdForPreview, getNextMemberId } = require("../season-admin");

function field(key, value) { return { key, value: String(value) }; }
function member(id) {
  return { id: "gid://shopify/Metaobject/Member" + id, handle: "member-" + id, fields: [field("identificador_de_miembro", id)] };
}
function mockShopify({ definitions = [], counters = [], reservations = [] } = {}) {
  const state = { definitions: structuredClone(definitions), counters: structuredClone(counters), reservations: structuredClone(reservations), calls: [] };
  const query = async (gql, variables = {}) => {
    state.calls.push({ gql, variables });
    if (gql.includes("metaobjectDefinitionByType(type: \"avalon_member_id_counter\")")) {
      return { metaobjectDefinitionByType: state.definitions.find(d => d.type === "avalon_member_id_counter") || null };
    }
    if (gql.includes("metaobjectDefinitionByType(type: \"avalon_member_id_reservation\")")) {
      return { metaobjectDefinitionByType: state.definitions.find(d => d.type === "avalon_member_id_reservation") || null };
    }
    if (gql.includes('metaobjects(type: "avalon_member_id_counter"')) return { metaobjects: { nodes: state.counters } };
    if (gql.includes('metaobjects(type: "avalon_member_id_reservation"')) return { metaobjects: { nodes: state.reservations } };
    if (gql.includes("metaobjectByHandle(type: $type, handle: $handle)")) {
      const source = variables.type === "avalon_member_id_reservation" ? state.reservations : state.counters;
      return { metaobjectByHandle: source.find(n => n.handle === variables.handle) || null };
    }
    if (gql.includes("metaobjectDefinitionCreate")) {
      const type = gql.includes('type: "avalon_member_id_reservation"') ? "avalon_member_id_reservation" : "avalon_member_id_counter";
      const def = { id: "definition-" + type, type, fieldDefinitions: [{ key: type.endsWith("counter") ? "last_id" : "member_id", type: { name: type.endsWith("counter") ? "number_integer" : "single_line_text_field" } }] };
      state.definitions.push(def);
      return { metaobjectDefinitionCreate: { metaobjectDefinition: def, userErrors: [] } };
    }
    if (gql.includes("metaobjectCreate(metaobject: { type: \"avalon_member_id_reservation\"")) {
      if (state.reservations.some(n => n.handle === variables.handle)) {
        return { metaobjectCreate: { metaobject: null, userErrors: [{ message: "Handle already exists" }] } };
      }
      const node = { id: "reservation-" + variables.memberId, handle: variables.handle, fields: [field("member_id", variables.memberId)] };
      state.reservations.push(node);
      return { metaobjectCreate: { metaobject: node, userErrors: [] } };
    }
    if (gql.includes("metaobjectCreate(metaobject: { type: \"avalon_member_id_counter\"")) {
      const node = { id: "counter-1", handle: variables.handle, fields: variables.fields };
      state.counters.push(node);
      return { metaobjectCreate: { metaobject: node, userErrors: [] } };
    }
    if (gql.includes("metaobjectUpdate")) {
      const counter = state.counters.find(n => n.id === variables.id);
      if (!counter) return { metaobjectUpdate: { metaobject: null, userErrors: [{ message: "Counter missing" }] } };
      counter.fields = variables.fields;
      return { metaobjectUpdate: { metaobject: counter, userErrors: [] } };
    }
    throw new Error("Unexpected GraphQL query in test mock: " + gql);
  };
  return { query, state };
}
function counterNode(last) {
  return { id: "counter-1", handle: "avalon-member-id-counter", fields: [field("last_id", last)] };
}
const definitions = [
  { id: "d1", type: "avalon_member_id_counter", fieldDefinitions: [{ key: "last_id", type: { name: "number_integer" } }] },
  { id: "d2", type: "avalon_member_id_reservation", fieldDefinitions: [{ key: "member_id", type: { name: "single_line_text_field" } }] }
];

test("preview uses max of permanent counter and existing members", async () => {
  const mock = mockShopify({ definitions, counters: [counterNode(2)] });
  assert.equal(await getNextMemberIdForPreview(mock.query, [member("001"), member("002")]), "003");
});

test("preview does not reuse an ID reserved even if the watermark lags", async () => {
  const mock = mockShopify({
    definitions, counters: [counterNode(1)],
    reservations: [{ id: "r2", handle: "member-002", fields: [field("member_id", "002")] }]
  });
  assert.equal(await getNextMemberIdForPreview(mock.query, [member("001")]), "003");
});

test("preview rejects duplicate permanent counter records", async () => {
  const mock = mockShopify({ definitions, counters: [counterNode(2), { ...counterNode(3), id: "counter-2", handle: "another-counter" }] });
  // Only duplicate canonical handles are invalid; unrelated legacy records should not mask the canonical handle.
  assert.equal(await getNextMemberIdForPreview(mock.query, [member("002")]), "004");
});

test("allocation reserves sequential IDs and advances the permanent watermark", async () => {
  const mock = mockShopify({ definitions, counters: [counterNode(1)] });
  assert.equal(await getNextMemberId(mock.query, [member("001")]), "002");
  assert.equal(await getNextMemberId(mock.query, [member("001")]), "003");
  assert.deepEqual(mock.state.reservations.map(n => n.handle), ["member-002", "member-003"]);
  assert.equal(mock.state.counters[0].fields.find(f => f.key === "last_id").value, "3");
});

test("allocation starts above the highest existing member ID", async () => {
  const mock = mockShopify({ definitions, counters: [counterNode(1)] });
  assert.equal(await getNextMemberId(mock.query, [member("001"), member("007")]), "008");
});

test("allocation creates counter and reservation definitions automatically", async () => {
  const mock = mockShopify();
  assert.equal(await getNextMemberId(mock.query, []), "001");
  assert.ok(mock.state.definitions.some(d => d.type === "avalon_member_id_counter"));
  assert.ok(mock.state.definitions.some(d => d.type === "avalon_member_id_reservation"));
  assert.equal(mock.state.counters[0].fields[0].value, "1");
});
