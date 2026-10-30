// OpenSubsonic / Subsonic state shared by main and renderer. Types only.

export interface SubsonicSettings {
  server: string;
  username: string;
  /** Stored (encrypted); values never leave the main process. */
  hasPassword: boolean;
  hasApiKey: boolean;
}

export interface SubsonicStatus {
  state: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  serverType?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
  /** The server offers OpenSubsonic API keys (apiKeyAuthentication). */
  apiKeySupported?: boolean;
  /** How this app signed in, for display. */
  auth?: string;
  /** http://127.0.0.1:<port>/subsonic/<key>: stream/<id>.<ext>, cover/<id>. */
  proxyBase?: string;
}

/** Song fields the library uses (Subsonic "Child"). */
export interface SubsonicSong {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  suffix?: string;
  coverArt?: string;
  track?: number;
}
