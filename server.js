const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const BUILD = "avalon-hall-of-fame-v5-season-admin";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SHOPIFY_SHOP = (process.env.SHOPIFY_SHOP || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const HTML_PATH = path.join(__dirname, "public", "index.html");
const { handleSeasonAdmin } = require("./season-admin");

function send(res, status, body) { res.writeHead(status, { "content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*" }); res.end(JSON.stringify(body,null,2)); }
function validShop(shop) { return typeof shop==="string" && /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop); }
function configured() { return Boolean(APP_URL && SHOPIFY_API_KEY && SHOPIFY_API_SECRET && validShop(SHOPIFY_SHOP)); }
function clean(value) { return String(value ?? "").trim(); }
function numberField(fields,...keys) { for(const key of keys){const value=fields[key];if(value!==undefined&&value!==null&&value!==""){const parsed=Number(value);if(Number.isFinite(parsed))return parsed;}}return 0; }
function fieldMap(fields) { const out={};for(const item of fields||[])out[item.key]=item.value;return out; }
function normalizeRecord(node) {
  const fields=fieldMap(node.fields),minutes=numberField(fields,"minutos","minutes"),seconds=numberField(fields,"segundos","seconds"),milliseconds=numberField(fields,"milisegundos","milisegundos_","milliseconds","milisegundos_ms");
  return {id:node.id,handle:node.handle,fields,competition:clean(fields.nombre_de_la_competicion||fields.nombre_de_competicion||fields.competicion),game:clean(fields.juego),category:clean(fields.categoria),season:clean(fields.temporada),player:clean(fields.nombre_del_jugador||fields.nombre_de_jugador||fields.jugador),guild:clean(fields.nombre_del_gremio||fields.nombre_de_gremio||fields.gremio),challenge:clean(fields.jefe_o_desafio||fields["jefe_o_desafío"]||fields.jefe||fields.desafio),minutes,seconds,milliseconds,timeMs:minutes*60000+seconds*1000+milliseconds,score:numberField(fields,"puntuacion","puntuación","score"),evidence:clean(fields.evidencia),verified:["true","1"].includes(clean(fields.verificado).toLowerCase())};
}
let tokenCache={token:"",expiresAt:0};
async function getToken(){
  if(tokenCache.token&&Date.now()<tokenCache.expiresAt-60000)return tokenCache.token;
  const response=await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({client_id:SHOPIFY_API_KEY,client_secret:SHOPIFY_API_SECRET,grant_type:"client_credentials"})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error(`Token Shopify: ${String(data.error_description||data.error||`HTTP ${response.status}`).slice(0,240)}`);
  tokenCache={token:data.access_token,expiresAt:Date.now()+Number(data.expires_in||86399)*1000};return tokenCache.token;
}
async function shopifyQuery(query,variables={}){
  const token=await getToken(),response=await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json","x-shopify-access-token":token},body:JSON.stringify({query,variables})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`Admin API Shopify: HTTP ${response.status}. Revisa versión, instalación y permisos.`);
  if(data.errors?.length)throw new Error(`GraphQL Shopify: ${data.errors.map(e=>e.message).filter(Boolean).join("; ").slice(0,300)}`);
  return data.data;
}
async function fetchMetaobjects(type,limit=250){
  const all=[];let after=null;
  while(all.length<limit){
    const data=await shopifyQuery("query($type: String!, $after: String) { metaobjects(type: $type, first: 100, after: $after) { nodes { id handle type fields { key value } } pageInfo { hasNextPage endCursor } } }",{type,after});
    const connection=data.metaobjects;all.push(...connection.nodes);
    if(!connection.pageInfo.hasNextPage||!connection.pageInfo.endCursor)break;after=connection.pageInfo.endCursor;
  }
  return all.slice(0,limit);
}
function normalizeGame(value){
  const normalized=clean(value).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]/g,"");
  if(["origin","7dso","7dsorigin","thesevendeadlysinsorigin"].includes(normalized))return "origin";
  if(["grandcross","7dsgc","7dsgrandcross"].includes(normalized))return "grandcross";
  return normalized;
}
function normalizeCategory(value){
  const normalized=clean(value).toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/[·•—–]/g," ").replace(/\\s+/g," ").trim();
  if(["jefes","origin jefes"].includes(normalized))return "jefes";
  if(["gremios","origin gremios"].includes(normalized))return "gremios";
  return normalized;
}
function filterLeaderboard(records,params){
  const game=normalizeGame(params.get("game")),category=normalizeCategory(params.get("category")),season=clean(params.get("season")).toLowerCase(),challenge=clean(params.get("challenge")).toLowerCase(),verifiedOnly=params.get("verified")==="true";
  return records.filter(r=>!game||normalizeGame(r.game)===game).filter(r=>!category||normalizeCategory(r.category)===category).filter(r=>!season||r.season.toLowerCase()===season).filter(r=>!challenge||r.challenge.toLowerCase()===challenge).filter(r=>!verifiedOnly||r.verified).sort((a,b)=>{if(a.timeMs>0&&b.timeMs>0&&a.timeMs!==b.timeMs)return a.timeMs-b.timeMs;if(a.timeMs>0&&b.timeMs<=0)return -1;if(a.timeMs<=0&&b.timeMs>0)return 1;return b.score-a.score;}).map((r,index)=>({rank:index+1,...r,formattedTime:r.timeMs>0?`${r.minutes}:${String(r.seconds).padStart(2,"0")}.${String(r.milliseconds).padStart(3,"0")}`:null}));
}
const server=http.createServer(async(req,res)=>{
  const adminHandled = await handleSeasonAdmin(req,res,new URL(req.url,APP_URL||"http://localhost"),{send,clean,shopifyQuery,fetchMetaobjects,normalizeRecord,filterLeaderboard});
  if (adminHandled) return;
  const url=new URL(req.url,APP_URL||"http://localhost");
  if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET, OPTIONS","access-control-allow-headers":"content-type"});return res.end();}
  if(req.method==="GET"&&url.pathname==="/admin-seasons"){
    const adminPath=path.join(__dirname,"public","admin-seasons.html");
    if(fs.existsSync(adminPath)){res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});return fs.createReadStream(adminPath).pipe(res);}
    return send(res,404,{ok:false,error:"No se encontró el panel administrativo."});
  }
  if(req.method==="GET"&&url.pathname==="/"){
    if(fs.existsSync(HTML_PATH)){res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-cache"});return fs.createReadStream(HTML_PATH).pipe(res);}
    return send(res,500,{ok:false,error:"No se encontró public/index.html. Revisa que el archivo esté guardado en la rama main.",build:BUILD});
  }
  if(req.method==="GET"&&["/health","/version"].includes(url.pathname))return send(res,200,{ok:true,service:"Avalon — Gestor del Salón de la Fama",status:"servidor activo",build:BUILD,shopifyConfigured:configured(),shop:validShop(SHOPIFY_SHOP)?SHOPIFY_SHOP:null});
  if(req.method==="GET"&&url.pathname==="/shopify-test"){
    if(!configured())return send(res,503,{ok:false,connected:false,build:BUILD,error:"Revisa las variables de Render y SHOPIFY_SHOP."});
    try{const data=await shopifyQuery("query { shop { name myshopifyDomain } metaobjectDefinitions(first: 30) { nodes { type name } } }");return send(res,200,{ok:true,connected:true,build:BUILD,shop:data.shop,metaobjectDefinitions:data.metaobjectDefinitions.nodes});}
    catch(error){return send(res,502,{ok:false,connected:false,build:BUILD,error:error.message||"No se pudo conectar con Shopify."});}
  }
  if(req.method==="GET"&&url.pathname==="/api/definitions"){
    try{const data=await shopifyQuery("query { metaobjectDefinitions(first: 50) { nodes { type name fieldDefinitions { key name type { name } } } } }");return send(res,200,{ok:true,definitions:data.metaobjectDefinitions.nodes});}
    catch(error){return send(res,502,{ok:false,error:error.message});}
  }
  if(req.method==="GET"&&url.pathname==="/api/competitions"){
    try{const nodes=await fetchMetaobjects("registro_competicion");return send(res,200,{ok:true,count:nodes.length,competitions:nodes.map(normalizeRecord)});}
    catch(error){return send(res,502,{ok:false,error:error.message,hint:"Comprueba el handle registro_competicion y los permisos de metaobjetos."});}
  }
  if(req.method==="GET"&&url.pathname==="/api/leaderboard"){
    try{const nodes=await fetchMetaobjects("registro_competicion"),leaderboard=filterLeaderboard(nodes.map(normalizeRecord),url.searchParams);return send(res,200,{ok:true,count:leaderboard.length,filters:Object.fromEntries(url.searchParams.entries()),leaderboard});}
    catch(error){return send(res,502,{ok:false,error:error.message,hint:"Comprueba el handle registro_competicion y los permisos de metaobjetos."});}
  }
  if(req.method==="GET"&&url.pathname==="/api/guilds"){
    try{
      const nodes=await fetchMetaobjects("ranking_gremios"),game=clean(url.searchParams.get("game")).toLowerCase(),verifiedOnly=url.searchParams.get("verified")==="true";
      const guilds=nodes.map(node=>{
        const fields=fieldMap(node.fields),pick=(...keys)=>{for(const key of keys)if(fields[key]!==undefined&&fields[key]!==null&&fields[key]!=="")return fields[key];return "";};
        const rawLogo=pick("logo_del_gremio","logo_gremio","logo");let logo=clean(rawLogo);if(logo&&!/^https:\/\//i.test(logo))logo="";
        return {id:node.id,name:clean(pick("nombre_del_gremio","nombre_de_gremio","gremio","nombre")),game:clean(pick("juego"))||"Origin",score:numberField(fields,"puntuacion","puntuación","score"),verified:["true","1"].includes(clean(pick("verificado")).toLowerCase()),logo};
      }).filter(g=>g.name).filter(g=>!game||g.game.toLowerCase()===game).filter(g=>!verifiedOnly||g.verified).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,"es")).map((g,index)=>({rank:index+1,...g}));
      return send(res,200,{ok:true,count:guilds.length,guilds});
    }catch(error){return send(res,502,{ok:false,error:error.message,hint:"Comprueba el handle ranking_gremios y los permisos de metaobjetos."});}
  }
  if(req.method==="GET"&&url.pathname==="/api/titles"){
    try{const nodes=await fetchMetaobjects("catalogo_titulos");return send(res,200,{ok:true,count:nodes.length,titles:nodes.map(node=>({id:node.id,handle:node.handle,fields:fieldMap(node.fields)}))});}
    catch(error){return send(res,502,{ok:false,error:error.message});}
  }
  if(req.method==="GET"&&url.pathname==="/api/members"){
    try{const nodes=await fetchMetaobjects("perfil_de_miembro");return send(res,200,{ok:true,count:nodes.length,members:nodes.map(node=>({id:node.id,handle:node.handle,fields:fieldMap(node.fields)}))});}
    catch(error){return send(res,502,{ok:false,error:error.message});}
  }
  return send(res,404,{ok:false,error:"No encontrado",build:BUILD,requestedPath:url.pathname});
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Avalon Gestor ${BUILD} escuchando en el puerto ${PORT}`));