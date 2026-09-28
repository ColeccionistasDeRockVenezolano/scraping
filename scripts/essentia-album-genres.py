#!/usr/bin/env python3
"""CRV · Género de disco inferido del audio del video (Essentia, Discogs-EffNet 400 estilos).

Es inferencia, no una fuente: su salida es evidencia para medir o para el
expediente de Laya, nunca se escribe directo en el catálogo.

Entrada: JSON con [{id, artist, title, video_id, dur, ...}]. Salida: JSONL con
los estilos más probables por disco (promedio de 8 ventanas de 30 s repartidas
entre el 10 % y el 90 % del video). Reanudable: salta los ids ya escritos.

  ~/.venvs/essentia/bin/python scripts/essentia-album-genres.py entrada.json salida.jsonl [carpeta_audio]
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from essentia.standard import MonoLoader, TensorflowPredict2D, TensorflowPredictEffnetDiscogs

MODELS = Path.home() / ".cache/essentia-models"
SR = 16000
WINDOWS = 8
WINDOW_SECONDS = 30
YT_DLP = str(Path(sys.executable).with_name("yt-dlp"))


def download(video_id: str, folder: Path) -> Path:
    target = folder / f"{video_id}.m4a"
    if not target.exists():
        subprocess.run([YT_DLP, "-q", "-f", "bestaudio[ext=m4a]/bestaudio", "-o", str(target),
                        f"https://www.youtube.com/watch?v={video_id}"], check=True)
    return target


def windows(audio: np.ndarray) -> np.ndarray:
    size = WINDOW_SECONDS * SR
    if len(audio) <= size * WINDOWS:
        return audio
    starts = np.linspace(0.1 * len(audio), 0.9 * len(audio) - size, WINDOWS).astype(int)
    return np.concatenate([audio[start:start + size] for start in starts])


def main() -> None:
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    folder = Path(sys.argv[3]) if len(sys.argv) > 3 else output.parent / "audio"
    folder.mkdir(parents=True, exist_ok=True)
    classes = json.loads((MODELS / "genre_discogs400-discogs-effnet-1.json").read_text())["classes"]
    embedder = TensorflowPredictEffnetDiscogs(graphFilename=str(MODELS / "discogs-effnet-bs64-1.pb"), output="PartitionedCall:1")
    head = TensorflowPredict2D(graphFilename=str(MODELS / "genre_discogs400-discogs-effnet-1.pb"),
                               input="serving_default_model_Placeholder", output="PartitionedCall:0")
    done = set()
    if output.exists():
        done = {json.loads(line)["id"] for line in output.read_text().splitlines() if line.strip()}
    for album in json.loads(source.read_text()):
        if album["id"] in done:
            continue
        try:
            path = download(album["video_id"], folder)
            audio = windows(MonoLoader(filename=str(path), sampleRate=SR, resampleQuality=4)())
            scores = head(embedder(audio)).mean(axis=0)
        except Exception as error:  # un video caído no frena la muestra
            print(f"{album['id']}: {error}", file=sys.stderr)
            continue
        top = np.argsort(scores)[::-1][:8]
        row = {**album, "styles": [{"label": classes[i], "p": round(float(scores[i]), 4)} for i in top]}
        with output.open("a") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.remove(path)
        print(f"{album['artist']} — {album['title']}: " + ", ".join(f"{s['label']} {s['p']:.2f}" for s in row["styles"][:3]), flush=True)


if __name__ == "__main__":
    main()
