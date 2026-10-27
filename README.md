# Picks NFL · Puntos de confianza

Web app estática (HTML + CSS + JS, sin dependencias ni servidor) que calcula cada semana cómo repartir los puntos de confianza del Pick'em de Yahoo NFL: el partido más seguro recibe el máximo y el más parejo recibe 1.

## Cómo usarla

1. Abre `index.html` en el navegador, o publícala con GitHub Pages (*Settings → Pages → Deploy from branch → main*); la app queda en `https://carsam68-monheyb.github.io/PicksNFLYahoo/`.
2. La app descarga de la API pública de ESPN el calendario, los resultados de todas las semanas y el reporte de lesiones. Las semanas terminadas se guardan en caché local.
3. Se abre en la semana por jugar. Cada partido muestra los puntos asignados, el pick, la probabilidad, la línea estimada y los factores que la explican. **Detalle** desglosa todo.
4. Si no estás de acuerdo: toca al otro equipo para cambiar el pick, usa ▲ ▼ para reordenar, y en **Bajas** marca jugadores como *clave* o *ignorar*. Todo se guarda en tu navegador.
5. **Copiar lista** deja el reparto en texto para pasarlo a Yahoo.
6. **Ajustes** permite calibrar el modelo (recencia, ventaja de local, peso de bajas, rivales comunes, etc.).

Funciona desde la semana 1 hasta el Super Bowl (comodines, divisional, campeonatos y Super Bowl como sede neutral).

## Cómo decide

Solo usa resultados de la temporada en curso.

- **Rating por equipo**: Simple Rating System (margen promedio ajustado por fuerza de los rivales, resuelto iterativamente) con tope de margen, descuento de ventaja de local, recencia (la última jornada pesa más) y regularización. Se mezcla con el récord ponderado para reflejar la posición en la tabla.
- **Correlaciones**: enfrentamiento directo previo, rivales comunes (comparación de márgenes contra los mismos rivales) y cadenas transitivas (A venció a X y X venció a B).
- **Bajas**: reporte de lesiones de ESPN; cada jugador resta según posición (QB 6, RB/WR 1.5, CB 1.2…) y estatus (Out/IR 100 %, Doubtful 75 %, Questionable 35 %), con tope por equipo. Solo el primer QB listado cuenta como titular.
- **Línea → probabilidad**: distribución normal con desviación de 13.5 puntos. Los partidos se ordenan por probabilidad del equipo elegido y reciben N…1 puntos.

Los detalles y los valores por defecto están en `model.js` (`DEFAULT_SETTINGS`, `POS_WEIGHTS`).

## Archivos

- `index.html` · estructura y pestaña *Método*.
- `styles.css` · estilos (paleta Monhey.B, modo oscuro).
- `model.js` · motor puro (normalización de ESPN, ratings, análisis de partido, reparto de puntos, posiciones). Se puede cargar en Node para pruebas.
- `app.js` · carga de datos, caché, estado y render.

## Si ESPN no responde

Los datos se piden desde el navegador a `site.api.espn.com`. Si tu red o navegador lo bloquea, en **Ajustes → Proxy CORS** puedes anteponer un proxy propio (se concatena la URL codificada).
