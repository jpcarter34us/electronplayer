// DAAP (iTunes sharing) state shared by main and renderer. Types only.

/** A library shared on the network, found by Bonjour or added by address. */
export interface DaapShare {
  /** "host:port", how the share is identified and stored. */
  id: string;
  name: string;
  /** Found on the local network. */
  discovered: boolean;
  /** As added by address in Settings (absent for shares only found by Bonjour). */
  address?: string;
  /** The share asks for a password (from Bonjour, or a refused login). */
  needsPassword?: boolean;
  /** A password for it is stored (encrypted). */
  hasPassword?: boolean;
}

export interface DaapSettings {
  /** Shares added by address ("host" or "host:port"). */
  servers: string[];
  /** Look for shares on the local network (Bonjour). */
  discover: boolean;
  /** The share to open next time. */
  lastShare: string;
}

export interface DaapStatus {
  state: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  /** The share asked for a password that was not given or was wrong. */
  needsPassword?: boolean;
  share?: { id: string; name: string };
  songCount?: number;
  /** http://127.0.0.1:<port>/daap/<key>/<share>/: stream/<id>.<ext>, art/<id>. */
  proxyBase?: string;
}

export interface DaapSong {
  id: number;
  title: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  /** Seconds. */
  duration?: number;
  track?: number;
  disc?: number;
  year?: number;
  /** File extension the server streams (mp3, m4a, flac, ...). */
  format?: string;
}

export interface DaapPlaylist {
  id: number;
  name: string;
  count?: number;
  smart?: boolean;
}
