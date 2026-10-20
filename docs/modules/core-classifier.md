# Module: music vs voice classifier (`crates/core/src/classifier.rs`)

## What it does
Decides whether a file is music or a voice recording, offline, with no model file.

## Pipeline
1. **Decode** up to 40 s (after skipping 1.5 s) with Symphonia; downmix to mono; keep the
   L/R Pearson correlation for stereo files.
2. **Features** (`extract_features`), all dimensionless:
   * `silence_ratio` – share of near-silent frames (speech pauses)
   * `energy_cv` – burstiness of frame energy
   * `syllable_modulation` – envelope energy in the 3–8 Hz band (syllable rate)
   * `beat_strength` – autocorrelation peak of the onset envelope at 50–200 BPM
   * `high_band_ratio`, `rolloff_hz` – bandwidth (phone recordings are narrow)
   * `centroid_cv`, `zcr_std`, `flatness` – spectral variability
   * `stereo_correlation` – ≈1 means "mono in a stereo file"
3. **Hints** (`Hints::from_meta`): format (`amr`, `3ga` lean voice), sample rate ≤ 22 kHz,
   mono, presence of artist/album tags, folder-name hints (`Recordings`, `WhatsApp Audio`,
   `Music`…), recorder-style file names (`PTT-…`, `20261014_091233`, `Rec …`).
4. **Score** (`score`): weighted sum → sigmoid → `voice_probability`. Confidence is
   `|p − 0.5| × 2`. Below `classifier.threshold` → `Kind::Unsure` (review queue).
5. **Reason**: up to four short phrases like `mono, 16 kHz, no artist tag, recordings folder`.
   Shown in the UI so the user understands the verdict.

## Tuning
All weights are in `Weights::default()`. Nothing else hard-codes numbers. To tune:
collect a folder of known music and known recordings, run `classify_file` on each (a small
example binary can be added under `crates/core/examples/`), and adjust weights until the two
distributions separate. Tests use synthetic signals so they stay deterministic.

## Replacing it with a model
Keep `classify_file`'s signature and the `Classification` type. Put the model inference
behind `score` (e.g. `tract-onnx` on a mel spectrogram) and keep the hint terms as a prior.

## Known limits
* Codecs Symphonia cannot decode (Dolby Digital Plus `ec-3` as in Samsung's bundled demo
  song, WMA, DTS) fall back to metadata-only scoring; the reason string says so.
* A recording *of* music (phone held up at a concert, a jam session) is music by signal and
  will be filed as music even from a Recordings folder; use "Move to voice recordings".
* Acoustic demos, podcasts with music beds and spoken-word albums are inherently ambiguous;
  they land in the review queue.
* Decoding cost is ~30–80 ms per file on a laptop; a first scan of thousands of files takes
  minutes. Re-scans skip unchanged files.
