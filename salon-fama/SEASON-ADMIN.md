# Avalon — administración de temporadas (implementación inicial)

Esta rama agrega un archivo histórico para temporadas del Salón de la Fama.

## Configuración necesaria en Render

Añade una variable de entorno privada:

- `AVALON_ADMIN_TOKEN`: clave larga y aleatoria, no la publiques ni la pongas en el tema de Shopify.

La página administrativa es `/admin-seasons`. Para consultar o archivar, introduce esa clave en el formulario.

## Flujo

1. Escribe la temporada exacta (debe coincidir con el campo `temporada` de los registros).
2. Selecciona la categoría.
3. Usa “Vista previa del ranking” para revisar los registros que se guardarán.
4. Confirma “Archivar temporada”.
5. El servidor crea un metaobjeto Shopify `avalon_season_archive` con nombre, categoría, fecha, y una instantánea JSON del ranking.

## Alcance / cuidado

- Esta primera versión conserva los registros originales: no los elimina ni los vacía.
- El archivo queda persistido en Shopify, no en el disco temporal de Render.
- Aún no otorga automáticamente títulos a `perfil_de_miembro`; se necesita mapear y probar los campos exactos de esa definición antes de tocar perfiles.
- El cierre manual no sustituye una autenticación de administrador integrada en Shopify. La ruta está protegida con `AVALON_ADMIN_TOKEN`.
- La creación de la definición y los metaobjetos requiere permisos de Shopify Admin API adecuados para metaobject definitions y metaobjects.
