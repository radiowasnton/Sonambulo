<div align="center">

<img src="extension/assets/brand/logo.svg" alt="" width="96" height="96">

# Sonámbulo

**La noche, más viva que nunca.** Modo oscuro, filtros y alto contraste para cada sitio web.

[English](README.md)

</div>

## Características

- **Por sitio:** Oscuro · OLED · Filtrado · Normal, más Alto contraste. Cada elección, OLED incluido, se recuerda por sitio (y para sus subdominios) y se puede cambiar desde la página Sitios web.
- **Alto contraste** Siete esquemas con sus filtros exactos: Aumentado, Escala de grises, Color invertido, Escala de grises invertida, y Amarillo / Cian / Verde sobre negro. La intensidad 60 % es la fuerza original. Un interruptor decide cómo se relacionan con el modo: **activado** (predeterminado) aplica el esquema sobre lo que el modo está mostrando, así "Color invertido" sobre OLED invierte el aspecto OLED; **desactivado** muestra el esquema solo, igual que la extensión original. Con el motor Estilos el esquema se aplica a los colores del CSS, por lo que las imágenes nunca se tocan; con Render es un filtro.
- **Oscuro** tiene dos motores, elegibles por sitio:
  - **Estilos** *(predeterminado)* recolorea el CSS de la página. Las imágenes, los videos y el contenido nunca se tocan.
  - **Render** invierte la página ya renderizada con un filtro de GPU. Funciona en casi todo, pero puede alterar las imágenes.
  OLED es el mismo oscuro con fondos de negro puro; Oscuro usa un gris suave.
- **Filtrado** conserva los colores originales y suaviza brillo, contraste, saturación y luz azul.
- **Fondo sólido** (por sitio, en Oscuro y OLED): aplana los fondos de `html` y `body`, imágenes y degradados incluidos, al color del modo. Úsalo cuando una página solo se oscurece un poco.
- El motor Render detecta los sitios que ya son oscuros y no los toca.
- 170 parches por sitio para el motor Estilos.
- Cada sitio guarda su configuración completa (modo, motor, esquema de alto contraste e intensidad, ajustes) y el engranaje de la página Sitios web la edita toda.
- Seguir el tema del sistema, horario diario, atajos de teclado, copia de seguridad y restauración.
- Importa las copias hechas con Sonámbulo 1.x.
- 51 idiomas, incluidos los de escritura de derecha a izquierda.
- Sin analíticas y sin código remoto. Las únicas peticiones de red son las hojas de estilo de la página que visitas, que el motor Estilos necesita para recolorearlas. No se envía nada a ningún sitio.

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Alt+Shift+D` | Alternar oscuro / normal en el sitio actual |
| `Alt+Shift+M` | Rotar Oscuro → Filtrado → Normal |
| `Alt+Shift+H` | Activar o desactivar el alto contraste en el sitio actual |
| `Alt+Shift+O` | Pausar / reanudar Sonámbulo |

Se cambian en `chrome://extensions/shortcuts` (Chrome) o en *Administrar atajos de extensiones* (Firefox).

## Desarrollo

Requiere Node 20+. No hay dependencias ni empaquetador: el código de `extension/` es exactamente lo que se publica.

```sh
npm test            # pruebas unitarias del núcleo
npm run check       # todos los idiomas tienen todos los textos
npm run build       # dist/sonambulo-<versión>-chrome.zip y -firefox.zip
```

Carga `extension/` como extensión descomprimida en Chrome, o `dist/firefox/manifest.json` desde `about:debugging` en Firefox. La estructura de carpetas está descrita en el [README en inglés](README.md#develop).

Guía para subir a las tiendas: [docs/PUBLICACION.md](docs/PUBLICACION.md).

## Licencia

[Apache License 2.0](LICENSE). Libre para usar, modificar y redistribuir; toda redistribución u obra derivada debe conservar el archivo [NOTICE](NOTICE) y acreditar a **radiowasnton** como autor original.
