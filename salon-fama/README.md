# Gestor del Salón de la Fama de El Lobby

Este directorio documenta y prepara la integración del Salón de la Fama con Shopify.

## Componentes planeados

- Registro de competición: resultados de Origin · Jefes, Origin · Gremios y Grand Cross · Jefes.
- Catálogo de títulos: títulos oficiales, históricos y exclusivos de El Lobby.
- Perfil de miembro: relación de miembros con sus títulos obtenidos.
- Ordenamiento de tiempos de menor a mayor usando minutos, segundos y milisegundos.
- Cierre de temporada con asignación permanente de títulos al perfil del miembro.

## Estado

Este repositorio contiene el sitio estático de El Lobby. La integración con Shopify requiere un servidor seguro para OAuth y Admin API; no debe implementarse exponiendo tokens en archivos del tema, JavaScript del navegador o el repositorio.

## Próximos pasos

1. Crear el servicio de backend y desplegarlo en un host HTTPS.
2. Configurar URL de la aplicación y URL de redirección en Shopify Dev Dashboard con las URL reales del host.
3. Solicitar únicamente los alcances necesarios para leer y modificar metaobjetos.
4. Confirmar los identificadores de campo reales generados por Shopify para las tres definiciones antes de programar las operaciones.
5. Probar con datos de prueba antes de asignar títulos de forma definitiva.

## Importante

No guardar aquí credenciales de Shopify, tokens, secretos de cliente ni claves privadas.
