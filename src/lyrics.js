// Lyrics for the song Spotify is playing, shared by the Lyrics widget and the line in Now playing.
// Rust fetches them from LRCLIB and keeps them (lyrics.rs); this file turns them into timed lines
// and works out which one is being sung. Only Spotify songs are looked up.

import { invoke } from "./api.js";

export const LEAD_MS = 250; // show a line a moment early: Spotify reports its position a little late
const RETRY_MS = 30 * 1000; // LRCLIB busy or no internet: try again this often while the song plays

export const isSpotify = (track) => /spotify/i.test(track?.app ?? "");

/**
 * The lyrics of `track` as {lines: [{ms, text}], synced}, {instrumental: true}, or null if there
 * are none. If LRCLIB can't be reached it calls onRetry() and tries again every 30 s, for as long
 * as stillWanted() (the same song is still playing); undefined if it gave up for that reason.
 */
export async function loadLyrics(track, stillWanted, onRetry = () => {}) {
  while (stillWanted()) {
    try {
      const found = await invoke("lyrics_get", {
        title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs,
      });
      return stillWanted() ? toLines(found) : undefined;
    } catch {
      if (!stillWanted()) return undefined;
      onRetry();
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

function toLines(found) {
  if (found?.instrumental) return { instrumental: true };
  if (found?.synced) return { lines: parseSynced(found.synced), synced: true };
  if (found?.plain) return { lines: found.plain.split(/\r?\n/).map((text) => ({ ms: 0, text: text.trim() })), synced: false };
  return null;
}

/** "[01:02.50] words" lines -> [{ms, text}] in time order. A line with several times appears at each. */
export function parseSynced(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    let rest = raw.trim();
    const times = [];
    for (let m; (m = rest.match(/^\[(\d+):(\d+(?:\.\d+)?)\]/)); rest = rest.slice(m[0].length)) {
      times.push(Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000));
    }
    for (const ms of times) lines.push({ ms, text: rest.trim() }); // no times: a tag like [ar:...], skipped
  }
  return lines.sort((a, b) => a.ms - b.ms);
}

/** Index of the line being sung at `ms`, or -1 before the first one. */
export function lineAt(lines, ms) {
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].ms <= ms) i++;
  return i;
}
