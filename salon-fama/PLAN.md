# Plan del Gestor del Salón de la Fama

## Datos de Shopify ya creados por la administración

Definiciones:
- `registro_competicion`
- `catalogo_titulos`
- `perfil_de_miembro`

Los identificadores internos de los campos deben verificarse directamente en Shopify; no asumirlos a partir de las etiquetas visibles.

## Reglas funcionales

1. Las categorías son independientes: `Origin · Jefes`, `Origin · Gremios`, `Grand Cross · Jefes`.
2. En `Origin · Jefes`, ordenar de menor a mayor por minutos, segundos y milisegundos.
3. Los resultados verificados pueden mostrarse públicamente; la edición y el cierre de temporadas deben quedar restringidos a administradores autorizados.
4. Al cerrar temporada, calcular puestos y añadir al perfil del miembro las referencias a los títulos ganados.
5. La concesión de títulos debe ser persistente: borrar o archivar los registros competitivos después del cierre no debe quitar los títulos ya ganados.
6. El proceso de cierre debe ser idempotente o detectar títulos ya asignados, para evitar duplicarlos si se ejecuta dos veces.

## Seguridad

- No exponer Admin API tokens en el frontend, tema Liquid o archivos públicos.
- El backend debe comprobar autenticación, autorización y tienda instalada antes de modificar metaobjetos.
- No ejecutar la asignación automática de premios hasta probarla con registros de prueba y un modo de vista previa.
- Usar HTTPS para la URL de la aplicación y sus URLs de redirección.

## Bloqueadores antes de implementar las operaciones de Shopify

- Host de backend elegido y URL pública desplegada.
- Configuración OAuth de Shopify.
- Identificadores de campo exactos de cada definición.
- Decisión sobre la política de acceso al sitio público y el panel de administración.
