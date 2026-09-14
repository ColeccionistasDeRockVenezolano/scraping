// E10 · Revisiones `youtube_match` que dejó `yt:reconcile` (E6).
//
// Tres formas de ambigüedad, cada una con su evidencia propia:
//  * Videoclip cuya canción está en varios discos: la descripción del video
//    lista a quien produjo, grabó, mezcló o masterizó el audio. Esos créditos
//    son de una grabación concreta, así que si solo un disco los tiene, esa es
//    su pista. Los músicos y compositores no sirven: se repiten en todas las
//    versiones de la canción.
//  * Concierto con un disco del artista de nombre parecido: la hoja nombra el
//    disco del concierto y el setlist del video se compara con sus pistas. Un
//    concierto se enlaza (album_kind='live_concert'), nunca crea un disco.
//  * Full Album con entradas del tracklist sin pista: una «Intro» que el disco
//    no tiene es un segmento del video; una errata en la misma posición es la
//    pista. Un disco sin pistas no se completa aquí: crear pistas es el core.
import { parseYouTubeTitle } from "../youtube/parsers.js";
import { youtubeLinkKey } from "../youtube/linker.js";
import { FactSheet, question, support, type Occurrence, type QuestionOutcome } from "./types.js";
import { textMentions, trackTitlesEquivalent, wordKey } from "./text.js";

export interface CreditRef { id: number; name: string; creditType: string; role: string; }
export interface YtTrack { id: number; disc: number; number: number; title: string; durationSeconds: number | null; }
export interface YtAlbum { id: number; title: string; year: number | null; type: string; classifications: string[]; tracks: YtTrack[]; credits: CreditRef[]; }
export interface TracklistEntry { position: number; title: string; startSeconds: number; }
export interface YtReviewInput {
  reviewId: number; videoDbId: number; videoId: string; title: string | null; description: string | null; durationSeconds: number | null;
  kind: string; category: string;
  artist: { id: number; name: string } | null;
  seed: { artist: string | null; album: string | null; year: number | null; type: string | null } | null;
  tracklist: TracklistEntry[];
  linkedAlbums: Array<YtAlbum & { albumKind: string; isPrimary: boolean }>;
  /** Videoclip: todas las pistas del artista con el título de la canción. */
  candidateTracks: Array<{ trackId: number; title: string; durationSeconds: number | null; album: YtAlbum }>;
  /** Concierto: los discos que la reconciliación propuso. */
  candidateAlbums: YtAlbum[];
  startMismatches: Array<{ trackId: number; title: string; core: number; video: number }>;
}

/** Créditos de una sesión de grabación concreta. */
const SESSION_CREDIT_TYPES = new Set(["producer", "recording", "mixing", "mastering", "photography", "artwork", "other"]);
const SEGMENT = /^(intro|outro|creditos?|credits|interludio|interlude|presentacion)$/u;
const TIMESTAMP = /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;
const STUDIO_TYPES = new Set(["studio_album", "ep", "single", "demo"]);

const albumLabel = (album: YtAlbum): string => `«${album.title}»${album.year ? ` (${album.year})` : ""} [${album.type}]`;

function isSegment(title: string, tracks: YtTrack[]): boolean {
  const key = wordKey(title.replace(TIMESTAMP, " "));
  return SEGMENT.test(key) && !tracks.some((track) => trackTitlesEquivalent(track.title, title));
}

/**
 * Orden de las marcas de tiempo del tracklist. Las subsecuencias crecientes
 * más largas dicen qué marcas encajan: una marca que está en todas es fiable;
 * una que solo está en algunas compite con otra y no se usa para enlazar
 * («44:40 - Llegaste Tarde» entre 27:51 y 34:24), aunque sirve de límite.
 */
function orderMembership(entries: TracklistEntry[]): { some: Set<number>; every: Set<number> } {
  const sorted = [...entries].sort((x, y) => x.position - y.position);
  const ending = sorted.map(() => 1); const starting = sorted.map(() => 1);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = 0; j < i; j += 1) if (sorted[j]!.startSeconds < sorted[i]!.startSeconds) ending[i] = Math.max(ending[i]!, ending[j]! + 1);
  }
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    for (let j = i + 1; j < sorted.length; j += 1) if (sorted[j]!.startSeconds > sorted[i]!.startSeconds) starting[i] = Math.max(starting[i]!, starting[j]! + 1);
  }
  const best = Math.max(0, ...ending);
  const inSome = sorted.map((_, i) => ending[i]! + starting[i]! - 1 === best);
  const perLength = new Map<number, number>();
  sorted.forEach((_, i) => { if (inSome[i]) perLength.set(ending[i]!, (perLength.get(ending[i]!) ?? 0) + 1); });
  return {
    some: new Set(sorted.filter((_, i) => inSome[i]).map((entry) => entry.position)),
    every: new Set(sorted.filter((_, i) => inSome[i] && perLength.get(ending[i]!) === 1).map((entry) => entry.position)),
  };
}

/** Posiciones cuya marca de tiempo no es fiable por romper el orden del tracklist. */
export function outOfOrderPositions(entries: TracklistEntry[]): Set<number> {
  const { every } = orderMembership(entries);
  return new Set(entries.filter((entry) => !every.has(entry.position)).map((entry) => entry.position));
}

function endOf(entry: TracklistEntry, entries: TracklistEntry[], duration: number | null, ordered: Set<number>): number | null {
  const next = entries.filter((item) => ordered.has(item.position) && item.startSeconds > entry.startSeconds).map((item) => item.startSeconds).sort((x, y) => x - y)[0];
  return next ?? (duration !== null && duration > entry.startSeconds ? duration : null);
}

function musicVideo(input: YtReviewInput): QuestionOutcome {
  const sheet = new FactSheet();
  const videoFact = sheet.add(`video:${input.videoId}`, `videoclip «${input.title ?? "(sin título)"}» (${input.durationSeconds ?? "?"} s)`);
  const options = input.candidateTracks.map((candidate) => ({
    key: `track:${candidate.trackId}`, label: `${candidate.title} · ${albumLabel(candidate.album)}`,
    target: { action: "link_video_track" as const, videoDbId: input.videoDbId, videoId: input.videoId, trackId: candidate.trackId, startSeconds: 0,
      endSeconds: input.durationSeconds && input.durationSeconds > 0 ? input.durationSeconds : null },
  }));
  const base = { questionKey: "video_track", question: `¿Qué pista del catálogo es el videoclip ${input.videoId}?`, options };
  if (input.candidateTracks.length < 2) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "music_video.no_candidates", reasoning: "la canción ya no está en varios discos del catálogo; la reconciliación debe recalcular el caso",
      facts: sheet.facts, evidence: [support(videoFact, "context")], target: null, aiEligible: false });
  }
  const text = wordKey(input.description ?? "");
  const artistKey = input.artist ? wordKey(input.artist.name) : "";
  const scored = input.candidateTracks.map((candidate) => {
    const technical = new Map<string, CreditRef[]>(); const lineup = new Set<string>();
    for (const credit of candidate.album.credits) {
      const key = wordKey(credit.name);
      if (key.split(" ").length < 2 || key === artistKey || !textMentions(text, key)) continue;
      if (SESSION_CREDIT_TYPES.has(credit.creditType)) technical.set(credit.name, [...(technical.get(credit.name) ?? []), credit]);
      else lineup.add(credit.name);
    }
    return { candidate, technical, lineup };
  });
  const facts = new Map(scored.map((item) => {
    const credits = [...item.technical.values()].flat();
    return [item.candidate.trackId, sheet.add(credits.length ? `album_credits:${credits.map((credit) => credit.id).join(",")}` : `album:${item.candidate.album.id}.credits`,
      `${albumLabel(item.candidate.album)}${item.candidate.album.classifications.length ? ` (${item.candidate.album.classifications.join(", ")})` : ""}, pista «${item.candidate.title}» `
      + `(${item.candidate.durationSeconds ?? "?"} s): créditos de grabación que la descripción del video también nombra: `
      + `${[...item.technical.entries()].map(([name, credits]) => `${name} (${[...new Set(credits.map((credit) => credit.creditType))].join("/")})`).join(", ") || "ninguno"}`
      + `; músicos nombrados: ${[...item.lineup].join(", ") || "ninguno"} de ${item.candidate.album.credits.filter((credit) => !SESSION_CREDIT_TYPES.has(credit.creditType)).length}`)] as const;
  }));
  const ranked = [...scored].sort((x, y) => y.technical.size - x.technical.size);
  const best = ranked[0]!;
  const others = ranked.slice(1);
  const decisive = best.technical.size >= 2
    && others.every((other) => other.technical.size < best.technical.size && [...other.technical.keys()].every((name) => best.technical.has(name)));
  if (decisive) {
    return question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "music_video.session_credits",
      reasoning: `la descripción nombra ${best.technical.size} créditos de grabación de ${albumLabel(best.candidate.album)} (${[...best.technical.keys()].join(", ")}); ningún otro disco aporta uno que ese no tenga`,
      facts: sheet.facts, evidence: [support(facts.get(best.candidate.trackId)!, "match"), ...others.map((other) => support(facts.get(other.candidate.trackId)!, "context")), support(videoFact, "context")],
      target: options.find((option) => option.key === `track:${best.candidate.trackId}`)!.target, aiEligible: false });
  }
  return question({ ...base, decision: "NEEDS_HUMAN", rule: "music_video.no_decisive_credits",
    reasoning: "los créditos de la descripción no señalan un único disco; la canción sigue en varios candidatos plausibles",
    facts: sheet.facts, evidence: [...scored.map((item) => support(facts.get(item.candidate.trackId)!, "context")), support(videoFact, "context")], target: null, aiEligible: true });
}

function setlistMatch(entries: TracklistEntry[], album: YtAlbum, duration: number | null) {
  const order = orderMembership(entries);
  const skip = new Set(entries.filter((entry) => !order.every.has(entry.position)).map((entry) => entry.position));
  const musical = entries.filter((entry) => !isSegment(entry.title, album.tracks));
  const used = new Set<number>();
  const matched: Array<{ entry: TracklistEntry; track: YtTrack }> = [];
  for (const entry of musical) {
    const track = album.tracks.find((candidate) => !used.has(candidate.id) && trackTitlesEquivalent(candidate.title, entry.title));
    if (!track) continue;
    used.add(track.id); matched.push({ entry, track });
  }
  const occurrences: Occurrence[] = matched.filter(({ entry }) => !skip.has(entry.position))
    .map(({ entry, track }) => ({ trackId: track.id, startSeconds: entry.startSeconds, endSeconds: endOf(entry, entries, duration, order.some) }));
  return { musical, matched, occurrences, skipped: matched.filter(({ entry }) => skip.has(entry.position)) };
}

function liveConcert(input: YtReviewInput, album: YtAlbum): QuestionOutcome {
  const sheet = new FactSheet();
  const parsed = parseYouTubeTitle(input.title ?? "");
  const videoYear = input.seed?.year ?? parsed.year;
  const videoFact = sheet.add(`video:${input.videoId}`, `concierto «${input.title ?? "(sin título)"}»${videoYear ? ` de ${videoYear}` : ""}, ${input.tracklist.length} marcas de tiempo`);
  const seedFact = input.seed ? sheet.add(`seed_upload:video:${input.videoId}`, `la hoja maestra dice: ${input.seed.artist ?? "?"} | ${input.seed.album ?? "?"} | ${input.seed.year ?? "sin año"} | ${input.seed.type ?? "sin tipo"}`) : null;
  const albumFact = sheet.add(`album:${album.id}`, `disco ${albumLabel(album)}${album.classifications.length ? ` (${album.classifications.join(", ")})` : ""} con ${album.tracks.length} pistas`);
  const match = setlistMatch(input.tracklist, album, input.durationSeconds);
  const setlistFact = sheet.add(`tracklist:video:${input.videoId}|album:${album.id}`,
    `${match.matched.length} de ${match.musical.length} canciones del video están en el disco${match.musical.length > match.matched.length ? `; faltan: ${match.musical.filter((entry) => !match.matched.some((item) => item.entry === entry)).map((entry) => `«${entry.title}»`).slice(0, 5).join(", ")}` : ""}`);
  const skippedFact = match.skipped.length ? sheet.add(`tracklist:video:${input.videoId}`, `marcas fuera de orden, no se enlazan: ${match.skipped.map(({ entry }) => `«${entry.title}» @${entry.startSeconds}s`).join(", ")}`) : null;
  const target = { action: "link_video_album" as const, videoDbId: input.videoDbId, videoId: input.videoId, albumId: album.id, albumKind: "live_concert" as const, occurrences: match.occurrences };
  const base = { questionKey: `concert_album:${album.id}`, question: `¿El concierto ${input.videoId} es la grabación de ${albumLabel(album)}?`,
    options: [{ key: `album:${album.id}`, label: `enlazar como live_concert${match.occurrences.length ? ` con ${match.occurrences.length} ocurrencias de pista` : ""}`, target }] };

  const sheetNames = Boolean(input.seed?.album) && youtubeLinkKey(input.seed!.album!) === youtubeLinkKey(album.title);
  const titleNames = youtubeLinkKey(album.title).length >= 4 && youtubeLinkKey(input.title ?? "").includes(youtubeLinkKey(album.title));
  const yearGap = videoYear && album.year ? Math.abs(videoYear - album.year) : null;
  const ratio = match.musical.length ? match.matched.length / match.musical.length : null;
  const studio = STUDIO_TYPES.has(album.type) && !album.classifications.some((item) => /live/iu.test(item));
  const identity = [seedFact && sheetNames ? support(seedFact, "match") : null, titleNames ? support(videoFact, "match") : null].filter((item) => item !== null);

  if (studio) {
    return sheetNames && seedFact
      ? question({ ...base, decision: "CONFLICT", rule: "live_concert.sheet_names_studio_album", reasoning: "la hoja asigna el concierto a un disco que el catálogo tiene como grabación de estudio",
        facts: sheet.facts, evidence: [support(seedFact, "conflict"), support(albumFact, "conflict")], target: null, aiEligible: false })
      : question({ ...base, decision: "KEEP_SEPARATE", rule: "live_concert.studio_album", reasoning: "un concierto no es la grabación de un disco de estudio aunque toque sus canciones",
        facts: sheet.facts, evidence: [support(albumFact, "separate"), support(videoFact, "separate")], target: null, aiEligible: false });
  }
  if (!sheetNames && !titleNames) {
    return question({ ...base, decision: "NEEDS_HUMAN", rule: "live_concert.no_identity", reasoning: "ni la hoja ni el título nombran ese disco",
      facts: sheet.facts, evidence: [support(videoFact, "context"), support(albumFact, "context")], target: null, aiEligible: true });
  }
  if (!album.tracks.length) {
    return sheetNames && yearGap === 0
      ? question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "live_concert.sheet_album_and_year",
        reasoning: "la hoja escrita por el propietario nombra ese disco para el concierto, con el mismo año; el disco no tiene pistas con que contrastar el setlist",
        facts: sheet.facts, evidence: [...identity, support(albumFact, "match")], target, aiEligible: false })
      : question({ ...base, decision: "NEEDS_HUMAN", rule: "live_concert.album_without_tracks", reasoning: "el disco no tiene pistas y la identidad no se sostiene solo con la hoja y el año",
        facts: sheet.facts, evidence: [support(albumFact, "context"), ...identity.map((item) => ({ ...item, supports: "context" as const }))], target: null, aiEligible: true });
  }
  if (ratio !== null && ratio >= 0.8 && (yearGap === null || yearGap <= 1)) {
    const yearNote = yearGap === 1 ? sheet.add(`album:${album.id}.release_year`, `el disco sale un año después del concierto (${videoYear} → ${album.year}): grabación y publicación`) : null;
    return question({ ...base, decision: "MATCH_HIGH_CONFIDENCE", rule: "live_concert.setlist_overlap",
      reasoning: `${sheetNames ? "la hoja nombra el disco" : "el título nombra el disco"} y ${match.matched.length} de ${match.musical.length} canciones del video son pistas suyas`,
      facts: sheet.facts, evidence: [...identity, support(setlistFact, "match"), ...(yearNote ? [support(yearNote, "context")] : []), ...(skippedFact ? [support(skippedFact, "context")] : [])],
      target, aiEligible: false });
  }
  if (sheetNames && ratio !== null && ratio < 0.5) {
    return question({ ...base, decision: "CONFLICT", rule: "live_concert.sheet_vs_setlist", reasoning: "la hoja nombra el disco pero el setlist del video casi no coincide con sus pistas",
      facts: sheet.facts, evidence: [support(setlistFact, "conflict"), ...(seedFact ? [support(seedFact, "conflict")] : [])], target: null, aiEligible: false });
  }
  return question({ ...base, decision: "NEEDS_HUMAN", rule: "live_concert.partial_overlap", reasoning: "el disco se nombra pero el setlist o el año no alcanzan para afirmar que es esa grabación",
    facts: sheet.facts, evidence: [support(setlistFact, "context"), support(albumFact, "context")], target: null, aiEligible: true });
}

function fullAlbum(input: YtReviewInput, album: YtAlbum & { albumKind: string; isPrimary: boolean }): QuestionOutcome[] {
  const albumFact = (sheet: FactSheet): string => sheet.add(`album:${album.id}`, `disco ${albumLabel(album)} enlazado como Full Album, ${album.tracks.length} pistas: ${album.tracks.map((track) => `${track.number}. ${track.title}`).join(" · ") || "ninguna"}`);
  if (!album.tracks.length) {
    const sheet = new FactSheet();
    const albumId = albumFact(sheet);
    const entries = sheet.add(`tracklist:video:${input.videoId}`, `el video marca ${input.tracklist.length} entradas: ${input.tracklist.map((entry) => `«${entry.title}»`).slice(0, 12).join(", ")}`);
    return [question({ questionKey: `album_tracks:${album.id}`, question: `¿Con qué pistas del catálogo casan las entradas del Full Album ${input.videoId}?`, options: [],
      decision: "NEEDS_HUMAN", rule: "full_album.album_without_tracks",
      reasoning: "el disco no tiene pistas en el catálogo: no hay nada con que casar, y crearlas desde el tracklist del canal es una escritura al core que decide una persona",
      facts: sheet.facts, evidence: [support(albumId, "context"), support(entries, "context")], target: null, aiEligible: false })];
  }
  const byKey = new Map<string, YtTrack[]>();
  for (const track of album.tracks) byKey.set(youtubeLinkKey(track.title), [...(byKey.get(youtubeLinkKey(track.title)) ?? []), track]);
  const assigned = new Map<number, YtTrack>();
  for (const entry of input.tracklist) {
    const candidates = byKey.get(youtubeLinkKey(entry.title)) ?? [];
    const track = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.disc === 1 && candidate.number === entry.position + 1);
    if (track) assigned.set(entry.position, track);
  }
  const assignedTracks = new Set([...assigned.values()].map((track) => track.id));
  const musical = input.tracklist.filter((entry) => !isSegment(entry.title, album.tracks)).sort((x, y) => x.position - y.position);
  const order = orderMembership(input.tracklist);
  const skip = new Set(input.tracklist.filter((entry) => !order.every.has(entry.position)).map((entry) => entry.position));
  const questions: QuestionOutcome[] = [];
  for (const entry of input.tracklist.filter((item) => !assigned.has(item.position))) {
    const sheet = new FactSheet();
    const albumId = albumFact(sheet);
    const entryFact = sheet.add(`tracklist:video:${input.videoId}@${entry.position}`, `entrada ${entry.position + 1} del tracklist: «${entry.title}» a los ${entry.startSeconds} s`);
    const base = { questionKey: `entry:${entry.position}`, question: `¿La entrada «${entry.title}» del video ${input.videoId} es una pista de ${albumLabel(album)}?` };
    if (isSegment(entry.title, album.tracks)) {
      const noTrack = sheet.add(`album:${album.id}.tracks`, `ninguna pista del disco se llama «${entry.title.replace(TIMESTAMP, "").trim()}»`);
      questions.push(question({ ...base, options: [], decision: "KEEP_SEPARATE", rule: "full_album.non_track_segment",
        reasoning: "es un segmento del video (introducción o créditos) que el disco no contiene",
        facts: sheet.facts, evidence: [support(entryFact, "separate"), support(noTrack, "separate"), support(albumId, "context")], target: null, aiEligible: false }));
      continue;
    }
    const ordinal = musical.findIndex((item) => item.position === entry.position);
    const track = album.tracks.find((candidate) => candidate.disc === 1 && candidate.number === ordinal + 1);
    const free = album.tracks.filter((candidate) => !assignedTracks.has(candidate.id));
    const options = free.map((candidate) => ({ key: `track:${candidate.id}`, label: `${candidate.number}. ${candidate.title}`,
      target: { action: "link_video_track" as const, videoDbId: input.videoDbId, videoId: input.videoId, trackId: candidate.id, startSeconds: entry.startSeconds, endSeconds: endOf(entry, input.tracklist, input.durationSeconds, order.some) } }));
    if (track && !assignedTracks.has(track.id) && trackTitlesEquivalent(entry.title, track.title) && !skip.has(entry.position)) {
      const trackFact = sheet.add(`track:${track.id}`, `pista ${track.number} del disco: «${track.title}»`);
      const neighbours = [musical[ordinal - 1], musical[ordinal + 1]].filter((item): item is TracklistEntry => Boolean(item && assigned.get(item.position)))
        .map((item) => sheet.add(`tracklist:video:${input.videoId}@${item.position}`, `la canción vecina «${item.title}» es la pista ${assigned.get(item.position)!.number}`));
      questions.push(question({ ...base, options, decision: "MATCH_HIGH_CONFIDENCE", rule: "full_album.near_title_same_position",
        reasoning: `«${entry.title}» es una errata de «${track.title}» y ocupa su misma posición entre las canciones del video`,
        facts: sheet.facts, evidence: [support(entryFact, "match"), support(trackFact, "match"), ...neighbours.map((id) => support(id, "context"))],
        target: options.find((option) => option.key === `track:${track.id}`)!.target, aiEligible: false }));
      continue;
    }
    questions.push(question({ ...base, options, decision: "NEEDS_HUMAN", rule: "full_album.unmatched_entry",
      reasoning: "la entrada no casa con ninguna pista por título ni por posición",
      facts: sheet.facts, evidence: [support(entryFact, "context"), support(albumId, "context")], target: null, aiEligible: free.length > 0 }));
  }
  for (const mismatch of input.startMismatches) {
    const sheet = new FactSheet();
    const fact = sheet.add(`track:${mismatch.trackId}.youtube_start_seconds|tracklist:video:${input.videoId}`, `«${mismatch.title}»: el catálogo dice ${mismatch.core} s y el video marca ${mismatch.video} s`);
    questions.push(question({ questionKey: `start:${mismatch.trackId}`, question: `¿En qué segundo empieza «${mismatch.title}» en ${input.videoId}?`, options: [],
      decision: "CONFLICT", rule: "full_album.start_mismatch", reasoning: "el inicio guardado contradice el del video; corregirlo es una escritura al core",
      facts: sheet.facts, evidence: [support(fact, "conflict")], target: null, aiEligible: false }));
  }
  return questions;
}

export function analyzeYouTubeReview(input: YtReviewInput): QuestionOutcome[] {
  if (input.kind === "music_video") return [musicVideo(input)];
  if (input.kind === "live_concert" && input.candidateAlbums.length) return input.candidateAlbums.map((album) => liveConcert(input, album));
  const fullLinks = input.linkedAlbums.filter((album) => album.albumKind === "full_album");
  if (input.kind === "full_album" && fullLinks.length) return fullLinks.flatMap((album) => fullAlbum(input, album));
  const sheet = new FactSheet();
  const fact = sheet.add(`video:${input.videoId}`, `revisión ${input.category} de un video ${input.kind} sin forma que el resolutor conozca`);
  return [question({ questionKey: "review", question: `¿Qué relación tiene el video ${input.videoId} con el catálogo?`, options: [],
    decision: "NEEDS_HUMAN", rule: "youtube.unsupported", reasoning: "el resolutor no tiene reglas para este tipo de revisión",
    facts: sheet.facts, evidence: [support(fact, "context")], target: null, aiEligible: false })];
}
