# Avalon

Sitio web comunitario para fans de **The Seven Deadly Sins: Origin**, **Grand Cross**, el anime y el manga. Proyecto independiente y no oficial.

## Estructura del proyecto

- `index.html`: portada de Avalon, novedades y accesos al universo 7DS.
- `styles.css`: estilos de la página principal.
- `script.js`: menú móvil y año del pie de página.
- `public/index.html`: Salón de la Fama, clasificación, gremios, catálogo de títulos y perfiles.
- `server.js`: servidor Node.js que expone las rutas API del ranking y conecta con Shopify.

## Publicación

La portada estática puede publicarse con GitHub Pages desde `main` y `/(root)`.

El Salón de la Fama necesita el servicio Node.js desplegado por separado. Para mostrar las clasificaciones, el iframe de Shopify debe apuntar al servicio Render configurado: `https://el-lobby.onrender.com/`.

## Rutas API del servicio

- `/health` y `/version`: comprobar estado y versión.
- `/api/leaderboard`: clasificación de récords.
- `/api/guilds`: ranking de gremios.
- `/api/titles`: catálogo de títulos.
- `/api/members`: perfiles de miembros.

## Nota de marca

El nombre público de la comunidad es **Avalon**. El nombre del repositorio debe reflejar la identidad Avalon; el cambio de nombre del repositorio se gestiona desde GitHub Settings. El nombre técnico del servicio de Render puede seguir siendo `el-lobby` sin afectar la marca visible.

## Aviso

Avalon es un proyecto de fans independiente y no está afiliado oficialmente con Netmarble ni con los titulares de la franquicia The Seven Deadly Sins.
