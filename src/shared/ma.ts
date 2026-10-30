// Music Assistant and Sendspin state shared by the main process and the
// renderer. Types only (compiled for both CommonJS and ES modules).

export interface MaSettings {
  /** As typed by the user: "192.168.1.20", "http://ma.local:8095", ... */
  server: string;
  /** A token is stored (encrypted); its value never leaves the main process. */
  hasToken: boolean;
  /** Run the Sendspin player so this app is a Music Assistant speaker. */
  sendspin: boolean;
  /** Name shown for this player in Music Assistant. */
  playerName: string;
  /**
   * How the Sendspin player reaches the server: 'server' through Music
   * Assistant's own address (its authenticated /sendspin proxy, so it works
   * wherever the server's http/https address does), or 'direct' to the
   * Sendspin port.
   */
  sendspinRoute: 'server' | 'direct';
  /** For 'direct': the Sendspin endpoint; default ws://<server host>:8927/sendspin. */
  sendspinUrl: string;
  /** What the stored token is: a sign-in session (renews itself) or a pasted long-lived token. */
  tokenKind: '' | 'session' | 'long-lived';
  /** Play Music Assistant audio through libaudcore (effects, equalizer, visualizations). */
  throughAudacious: boolean;
}

/** A sign-in provider other than username/password (e.g. Home Assistant). */
export interface MaLoginProvider {
  id: string;
  type: string;
  label: string;
}

export interface MaStatus {
  state: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  /** Not signed in, or the sign-in expired or was revoked. */
  needsSignIn?: boolean;
  /** Signed-in user's display name. */
  user?: string;
  serverName?: string;
  serverVersion?: string;
  schemaVersion?: number;
  /** http(s)://host:port, for building image URLs. */
  httpBase?: string;
}

export interface SendspinState {
  enabled: boolean;
  connection: 'off' | 'connecting' | 'connected' | 'error';
  error?: string;
  /** Code to enter in Music Assistant to pair this player, while pairing. */
  pairingCode?: string | null;
  /** Sendspin client id (public key); Music Assistant's player id for us. */
  clientId?: string;
  /** Audio is streaming to this player. */
  playing: boolean;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  /** Track position in ms at `progressAt` (Date.now()), advancing at `speed`. */
  progressMs: number;
  durationMs: number;
  progressAt: number;
  speed: number;
  /** Local output volume, 0-100. */
  volume: number;
  muted: boolean;
  /** Controller commands the server accepts (play, pause, next, seek, ...). */
  commands: string[];
  groupName?: string;
}

/** Which engine the transport controls and the main window shows. */
export type PlaybackSource = 'local' | 'ma';

/** Library item fields the browser uses (music_assistant_models MediaItem). */
export interface MaImage {
  type?: string;
  path: string;
  provider: string;
  remotely_accessible?: boolean;
  proxy_id?: string | null;
}

export interface MaItem {
  item_id: string;
  provider: string;
  name: string;
  version?: string;
  uri?: string;
  media_type: string;
  is_playable?: boolean;
  duration?: number;
  path?: string;
  label?: string;
  image?: MaImage | null;
  metadata?: { images?: MaImage[] | null };
  artists?: { name: string }[];
  album?: { name: string } | null;
}

export interface MaPlayer {
  player_id: string;
  name: string;
  display_name?: string;
  available: boolean;
  provider: string;
  playback_state?: string;
  hide_in_ui?: boolean;
  hidden?: boolean;
  enabled?: boolean;
}
