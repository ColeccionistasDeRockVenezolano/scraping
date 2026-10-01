# CRV: géneros por pista y álbum, tonalidad y Camelot desde audio

Estado: diseño para piloto. Fecha: 2026-09-29. No habilita descargas, análisis masivo ni publicación automática.

## Objetivo y límite de entrada

Analizar grabaciones que CRV pueda procesar legítimamente. Un enlace a YouTube, una marca `youtube_start_seconds` o una relación `media.video_tracks` identifica una posible grabación o segmento, pero no entrega por sí mismo un archivo de audio procesable. El piloto acepta archivos aportados por titulares/autorizados o una fuente que otorgue expresamente ese uso. Registrar alcance de la autorización, procedencia, hash y calidad del archivo antes de analizar. No usar una descarga automática de YouTube como vía de ingestión.

El resultado acústico es una sugerencia sobre una **grabación concreta**. Mezclas, remasterizaciones, directos y versiones pueden diferir; la relación con `public.tracks` debe verificarse. Un tracklist de un video largo requiere inicio y fin comprobados; si falta el fin o el segmento se solapa, el análisis queda pendiente.

## Datos nuevos, fuera del core `public`

- `media.audio_assets`: identificador, localizador privado del archivo, fuente/autorización, hash SHA-256, códec, duración, sample rate, canales, estado de acceso y fecha. El archivo no se publica mediante la API.
- `media.audio_track_segments`: `audio_asset_id`, `track_id`, inicio y fin en milisegundos, método de alineación, estado revisado y referencia a la evidencia. Dos pistas no deben usar accidentalmente el mismo segmento.
- `ingest.audio_analysis_runs`: hash del audio, segmento, versiones de código y modelos, parámetros, fecha, estado, errores y resultados crudos. Un cambio de audio, corte o modelo crea un nuevo run; no sobrescribe el anterior.
- `ingest.track_genres`: géneros del vocabulario vigente, principal/secundarios, estado `suggested`/`confirmed`/`rejected`, origen `audio_model` o `editorial`, modelo, score calibrado y run. Mantener decisiones humanas y evidencia de fuente separadas de las predicciones acústicas.
- `ingest.track_keys`: tonalidad (`tonic`, `mode`), Camelot derivado, fuerza/confianza, estabilidad temporal, estado, run y decisión humana. La clave Camelot se calcula de la tonalidad del mismo resultado o decisión; no se clasifica como una etiqueta independiente.

La API de pista debe indicar `genreOrigin: "track" | "album"` y mostrar género explícito confirmado de pista cuando exista. Sin ese dato, conserva la clasificación efectiva actual heredada del álbum. La tonalidad de una pista nunca se hereda del álbum. Un álbum conserva sus géneros de fuente/editoriales y puede recibir una **sugerencia acústica agregada** a partir de pistas analizadas; no se confirma ni reemplaza el principal solo por mayoría de pistas.

## Procesamiento

1. Validar autorización, identidad de grabación y segmento. Rechazar silencio, voz hablada, intros demasiado cortas, ruido dominante y cortes incompletos para la tarea de clave.
2. Decodificar a PCM localmente y analizar varias ventanas repartidas por la pista; guardar cobertura temporal y resultados por ventana. No elegir solo los primeros 30 segundos.
3. **Tonalidad:** estimar tónica, modo mayor/menor y fuerza con Essentia `KeyExtractor`/HPCP. Comparar ventanas y un segundo perfil; si hay modulación, atonalidad, ambigüedad mayor/relativa menor o baja estabilidad, guardar `unknown` o enviar a revisión. Convertir las 24 tonalidades mayor/menor a las 24 claves Camelot mediante una tabla fija con pruebas (por ejemplo, C mayor = 8B; A menor = 8A). No inferir la clave por género, BPM o texto.
4. **Género:** obtener scores multilabel con un clasificador de audio o embeddings musicales y un clasificador ajustado al vocabulario de CRV. Mapear etiquetas externas a familias y subgéneros solo cuando la equivalencia esté aprobada; conservar el score original y la versión del mapeo. Evaluar por separado familia, subgénero y segundo género.
5. **Álbum:** agregar pistas identificadas ponderando por duración válida, diversidad de pistas y acuerdo entre ventanas. Informar número de pistas cubiertas y proporción de duración cubierta. Si la cobertura es baja o el disco es un compilado/diverso, abstenerse de sugerir principal acústico.
6. Enviar las propuestas a la Mesa de Cotejo con acceso al segmento y a la comparación con fuentes. Publicar únicamente decisiones confirmadas. Toda corrección humana se conserva como ejemplo para la siguiente evaluación.

Laya sigue sirviendo para decisiones tipadas sobre los **resultados estructurados** del análisis y la evidencia editorial. El modelo Laya actual recibe texto/JSON, no la señal de audio; no es el extractor acústico.

## Piloto y criterio de salida

Primera muestra: discos con audio autorizado, pistas bien delimitadas y variedad de familias, décadas, directos y calidad de grabación. Separar por artista entre desarrollo y prueba para evitar que un modelo reconozca la producción de la misma banda. Revisores humanos etiquetan géneros multilabel y tonalidad/Camelot sin ver el resultado del modelo.

Medir cobertura de audio autorizado, exactitud de segmentación, precisión y recall por familia/subgénero, tasa de abstención, exactitud de tónica+modo y Camelot, y desacuerdos por calidad/mezcla. Reportar los resultados de álbum aparte de los de pista. Definir umbrales editoriales con esos datos antes de escribir sugerencias masivas o exponer filtros públicos.

## Integración por etapas

1. Inventario de archivos autorizados y asociación con pistas; lectura solamente.
2. Piloto de clave y Camelot por pista, con informe y revisión humana.
3. Piloto de géneros por pista y agregación por álbum contra muestra etiquetada.
4. Migraciones auxiliares, API y Mesa de Cotejo; salida sugerida primero.
5. Filtros de catálogo y anotación de Radio CRV por pista cuando exista un enlace inequívoco `video_tracks`. Versionar el contrato de radio; los videos de álbum completo sin pista identificada conservan la anotación del álbum.

## Fuentes técnicas para validar la implementación

- Essentia, KeyExtractor: https://essentia.upf.edu/reference/streaming_KeyExtractor.html
- Essentia, modelos de audio: https://essentia.upf.edu/models.html (comprobar licencia de cada modelo antes de incorporarlo).
- YouTube, condiciones de uso: https://www.youtube.com/t/terms
