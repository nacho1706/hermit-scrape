# Deal Hunter

Deal Hunter es una extensión de navegador para ayudar a revisar publicaciones de Facebook Marketplace según lo que buscas. Analiza las tarjetas visibles en una grilla, les asigna una etiqueta (`MATCH`, `SKIP` o `REVIEW`) y muestra un resumen en el panel lateral. También permite exportar los resultados de la sesión a CSV.

La extensión está construida con [WXT](https://wxt.dev/) y TypeScript. Para evaluar publicaciones usa Jev (`jev-1.13`) a través de OpenRouter y requiere tu propia API key; los cargos de esas consultas se hacen a tu cuenta de OpenRouter.

## Cómo funciona

1. En una página de grilla de Facebook Marketplace, la extensión observa las tarjetas de publicaciones que aparecen en pantalla. No hace clic, no desplaza la página ni escribe por ti.
2. Al abrir Deal Hunter desde la barra del navegador, el panel lateral permite definir la búsqueda.
3. El nombre o consulta y las publicaciones visibles se envían a Jev para estimar qué tan bien coincide cada artículo y detectar motivos concretos para descartarlo.
4. La extensión pinta la tarjeta con `MATCH`, `SKIP` o `REVIEW`, y actualiza conteos, tiempos y costo estimado en el panel. Las publicaciones que no tengan precio legible pueden quedar sujetas a los filtros locales de precio.
5. Los resultados se pueden descargar como `deal-hunter-session.csv`.

Las publicaciones nuevas se procesan en grupos pequeños. Los resultados se conservan durante la sesión del navegador para no volver a puntuar innecesariamente; al cambiar la búsqueda se recalculan para el nuevo criterio.

## Requisitos

- Node.js y npm.
- Un navegador Chromium con soporte para extensiones Manifest V3 y panel lateral.
- Una cuenta y una API key de OpenRouter con acceso al endpoint Jev.

## Instalación para desarrollo

```sh
git clone <URL-del-repositorio>
cd hermit
npm install
npm run dev
```

WXT inicia el modo de desarrollo y muestra cómo cargar la extensión en el navegador. Para generar la versión empaquetada:

```sh
npm run build
```

El resultado se genera en `.output/` (por defecto, para Chromium). En Chrome o Edge se puede cargar la carpeta de extensión generada desde la página de gestión de extensiones, con el modo de desarrollador habilitado.

## Configuración y uso

1. Instala o carga la extensión y abre su página de opciones.
2. Guarda tu clave de OpenRouter en el campo **OpenRouter key**. La clave se guarda en el almacenamiento local de la extensión, no se muestra de nuevo y se envía al servicio solo en el encabezado de autorización de las consultas.
3. Abre una grilla de Facebook Marketplace y el panel lateral de Deal Hunter.
4. Completa los campos disponibles:
   - **Query**: nombre o descripción breve del producto que buscas. Es necesario para iniciar la evaluación.
   - **Precio máximo** y **moneda**: límite opcional; la moneda predeterminada es ARS. Sin precio máximo no se aplica ese filtro.
   - **Ubicación**: una o más ubicaciones, separadas por punto y coma.
   - **Nota**: requisitos adicionales para evaluar la publicación.
5. Revisa las etiquetas y el resumen. Usa **Export CSV** para descargar los resultados de la sesión.

La consulta, los criterios y la clave se guardan localmente en el navegador. El análisis de publicaciones requiere conexión a Internet y usa tu cuenta de OpenRouter.

## Estado de las pruebas manuales

Se probaron los campos **Query** (nombre del producto) y **Ubicación**. Todavía no se probaron **Precio**, **Moneda** ni el **tipo de moneda**. Por lo tanto, esos campos están disponibles en la interfaz, pero su comportamiento no está validado manualmente.

## Comandos disponibles

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Inicia WXT en modo desarrollo. |
| `npm run build` | Compila la extensión. |
| `npm run test` | Ejecuta las pruebas automatizadas existentes. |
| `npm run typecheck` | Comprueba los tipos de TypeScript. |
