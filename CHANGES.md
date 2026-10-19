# Changes from upstream

This fork is based on Twilight Echo 1.3.1 from
[Px-asen/Twilight_Echo](https://github.com/Px-asen/Twilight_Echo). The upstream
project and its contributors retain their copyright and license notices.

## Added or changed in this fork

- Added a native local-music tag workshop with a sidebar entry.
- Added multi-source metadata matching with fallback across NetEase, QQ Music,
  Kuwo, and iTunes.
- Added batch matching and automatic application of high-confidence results;
  low-confidence matches are presented for manual selection.
- Added tag fields for title, artist, album, album artist, year, track/disc
  number, genre, lyricist, composer, lyrics, and cover art.
- Added filename-to-tag and tag-to-filename tools, conflict checks, and safe
  batch renaming.
- Added duplicate detection helpers for local music.
- Added write preflight checks, per-write backups, a journal, and rollback.
- Added DSF and DFF ID3v2 read/write support.
- Added M4A tag support, including compatibility for files with an empty
  `hdlr` box.

## Distribution and compliance changes

- Rewrote the README as an unofficial-fork document with upstream attribution,
  license information, privacy notes, and a vibe-coding risk warning.
- Added NOTICE and this CHANGES file.
- Pointed the in-app update and project links at this fork instead of the
  upstream release feed.
- Removed upstream sponsor, donation, QQ-group, and personal contact content
  from the in-app About page and from the fork documentation.
- Removed upstream promotional screenshots, sponsor payment images, and the
  upstream QQ-group QR image from the distributed source and release payload.
- Excluded bundled plugin test files from the packaged app to avoid shipping
  test fixtures and sample track names.
- Added the Apache license and NOTICE to the packaged resources.
- Disabled the legacy electron-updater configuration file in fork builds; the
  fork does not provide official automatic updates.

## Known risks

- This is a vibe-coding product. Behavior outside the tested tag-workshop flows
  may be incorrect or incomplete.
- Batch tag writes and renames modify files in place. Back up the music library
  before use.
- Online providers can fail, change APIs, rate-limit, or return incorrect
  metadata. Review low-confidence results.
- Windows packages are unsigned and may trigger SmartScreen warnings.
