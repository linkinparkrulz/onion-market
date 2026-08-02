// A player as seen by other clients. Note: the raw BIP47 payment code is NEVER
// sent to clients — only `avatar`, a one-way hash used to fetch the avatar image.
export interface PlayerState { id: number; nym: string; avatar: string; x: number; y: number }
export interface RoomMap { w: number; h: number; blocked: string[] }

// A door in a room that carries the logged-in identity to another node's onion.
export interface Portal {
  tile: string;
  name: string;
  onion: string;
  desc: string;
}

// A single item a vendor offers. Display-only; payment happens out-of-band in the
// customer's wallet using the stall's BIP47 payment code.
export interface Ware {
  name: string;
  priceSats?: number;
  desc?: string;
  img?: string;
}

// A market stall placed on a tile in a vendor room.
export interface Stall {
  tile: string;
  name: string;
  payCode: string;   // the vendor's own BIP47 payment code (public)
  wares: Ware[];
  qr?: string;       // data-URL QR of payCode, precomputed server-side
}

// Declarative vendor room definition, loaded from room.json.
export interface RoomConfig {
  name: string;
  w: number;
  h: number;
  blocked?: string[];
  stalls?: Stall[];
}

// A gossiped, self-signed record binding a node's onion to its identity pubkey.
export interface PeerRecord {
  onion: string;       // network identity (host[:port] in dev)
  pubKey: string;      // base64url Ed25519 SPKI DER
  name: string;
  desc: string;
  updatedAt: number;
  sig: string;         // base64url signature over the record with sig=''
}

export type ServerMsg =
  | { t: 'init'; you: number; name: string; map: RoomMap; players: PlayerState[]; portals?: Portal[]; stalls?: Stall[] }
  | { t: 'join'; player: PlayerState }
  | { t: 'leave'; id: number }
  | { t: 'state'; players: PlayerState[] }
  | { t: 'chat'; id: number; nym: string; text: string }
  | { t: 'sso'; dest: string; token: string };

export type ClientMsg =
  | { t: 'move'; x: number; y: number }
  | { t: 'chat'; text: string }
  | { t: 'portal'; dest: string };

export interface Auth47Proof {
  auth47_response?: string;
  challenge: string;
  nym: string;
  signature: string;
}

export interface NymProfile {
  paymentCode: string;
  nymName: string | null;
  nymID: string | null;
}
