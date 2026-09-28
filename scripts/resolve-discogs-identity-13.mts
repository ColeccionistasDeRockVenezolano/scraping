// Decisiones editoriales de identidad Discogs para la cola del 2026-09-27.
// Cada enlace se comprobó contra la discografía, portada o pistas del catálogo.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { saveIdentity } from "../src/genres/external/store.js";

const decisions = [
  { reviewId: 244927, kind: "album", entityId: 453, externalId: "master:1004239", name: "Limon Limonero", evidence: "LP de 12 pistas: Ella, Más Que Amor y Hang On Sloopy coinciden; el master 196818 solo contiene el sencillo de 2 pistas." },
  { reviewId: 244937, kind: "album", entityId: 445, externalId: "master:918584", name: "Fuera De Este Mundo", evidence: "Álbum de 11 pistas, incluido Esperando El Sol; el release rival solo contiene el sencillo Fuera De Este Mundo." },
  { reviewId: 244949, kind: "album", entityId: 444, externalId: "master:772427", name: "Fantasia", evidence: "Álbum de 9 pistas, incluidas Aquí Estás Otra Vez y Frívola; el release rival es un sencillo de Fantasía." },
  { reviewId: 245000, kind: "album", entityId: 5083, externalId: "release:30645034", name: "Me Conformo..!", evidence: "Disco de Cherry Navarro en Velvet con 12 pistas; coinciden Me conformo, No viviré sin ti, El ajuar y Silvia." },
  { reviewId: 245069, kind: "artist", entityId: 1009, externalId: "12377551", name: "4to Reich", evidence: "Perfil Discogs de banda punk venezolana formada en 1983; incluye Demo 1985, también presente en CRV. El perfil rival carece de esta discografía." },
  { reviewId: 245072, kind: "album", entityId: 1988, externalId: "release:7625204", name: "El Tren de la Vida", evidence: "Coinciden artista, título y portada del EP de Desorden Público; la ficha de CRV conserva el alias El Tren de la Vida (EP)." },
  { reviewId: 245075, kind: "album", entityId: 2288, externalId: "release:5572209", name: "Solo Éxitos", evidence: "La portada roja de Serie Premium de CRV coincide con esta edición; el release 9056963 tiene otra portada y otra selección de canciones." },
  { reviewId: 245113, kind: "album", entityId: 4827, externalId: "master:1302506", name: "Yo Creo En Dios", evidence: "Sencillo de 1969 de Las Cuatro Monedas; coinciden las dos pistas Yo Creo en Dios y Buena Suerte." },
  { reviewId: 245115, kind: "album", entityId: 4881, externalId: "release:27956133", name: "No Te Importe / Olvidala", evidence: "Coinciden artista, título, sello Sonus y las dos pistas No Te Importe y Olvidala." },
  { reviewId: 245117, kind: "album", entityId: 52, externalId: "master:269358", name: "Love Maniac", evidence: "LP de cinco pistas: Together To Heaven Or Hell y Sweet Lover Partes 1-3 coinciden; el master 269357 solo reúne el sencillo Love Maniac." },
  { reviewId: 245132, kind: "album", entityId: 2705, externalId: "release:38331051", name: "Todo Muerto", evidence: "Las cinco pistas coinciden en orden: Taxi, Toronja, Todo Muerto, Siete Cueros y Buen Doctor." },
  { reviewId: 245135, kind: "album", entityId: 2927, externalId: "release:15946052", name: "Los Locos De Caracas", evidence: "Coinciden las diez pistas del álbum de Víctor Cuica, incluidas Yembé, Tequila, Choroní y Afroblues." },
  { reviewId: 245143, kind: "album", entityId: 3795, externalId: "release:3525591", name: "The Witch", evidence: "LP de nueve pistas, incluidas La Bruja, Sr. Renny y Fin de un Sueño; el release 7542602 solo contiene el sencillo La Bruja." },
] as const;

async function main(): Promise<void> {
  console.log(decisions.map((row) => `${row.reviewId}: ${row.kind} ${row.entityId} → ${row.externalId}`).join("\n"));
  if (!process.argv.includes("--confirm")) return;
  const { runId, result } = await withOperatorRun({
    name: "resolve_discogs_identities",
    operator: "codex",
    note: "Cotejo manual de identidades Discogs con listas de pistas y portadas",
    params: { reviewIds: decisions.map((row) => row.reviewId) },
  }, async ({ client, runId }) => {
    const source = await client.query<{ id: string }>("SELECT id::text FROM ingest.genre_external_sources WHERE slug='discogs'");
    if (!source.rows[0]) throw new Error("falta Discogs en fuentes externas");
    const sourceId = Number(source.rows[0].id);
    for (const row of decisions) {
      const review = await client.query<{ kind: string; entity_id: string }>(`
        SELECT payload->>'entityKind' kind, payload->>'entityId' entity_id
          FROM ingest.review_queue WHERE id=$1 AND kind='genre_unknown' AND status='open'
            AND payload->>'genreCase'='external_ambiguous_identity'
            AND payload->>'externalSource'='discogs' FOR UPDATE`, [row.reviewId]);
      if (review.rows[0]?.kind !== row.kind || Number(review.rows[0].entity_id) !== row.entityId) {
        throw new Error(`revisión ${row.reviewId} cambió de estado o ficha`);
      }
      const existing = await client.query(`SELECT 1 FROM ingest.genre_external_identities
        WHERE entity_kind=$1 AND entity_id=$2 AND source_id=$3 AND status='matched'`, [row.kind, row.entityId, sourceId]);
      if (existing.rowCount) throw new Error(`la identidad ${row.kind} ${row.entityId} ya tiene un enlace confirmado`);
      await saveIdentity(client, {
        kind: row.kind, entityId: row.entityId, sourceId, externalId: row.externalId,
        externalName: row.name,
        externalUrl: row.kind === "artist"
          ? `https://www.discogs.com/artist/${row.externalId}`
          : `https://www.discogs.com/${row.externalId.replace(":", "/")}`,
        score: 1, signals: [{ name: "human_evidence", weight: 1, detail: row.evidence }],
        status: "matched", decidedBy: "codex", decisionKind: "human",
        reason: `${row.evidence} Discogs: ${row.externalId}.`, runId,
      });
      const closed = await client.query(`UPDATE ingest.review_queue
        SET status='approved', resolved_by='human', resolved_at=now(), updated_at=now(),
            resolution_note=$2 WHERE id=$1 AND status='open'`,
      [row.reviewId, `codex · run ${runId}: ${row.evidence}`]);
      if (closed.rowCount !== 1) throw new Error(`no se cerró la revisión ${row.reviewId}`);
    }
    return decisions.length;
  });
  console.log(`run ${runId}: ${result} identidades confirmadas`);
}

try {
  await main();
} finally {
  await closeDb();
}
