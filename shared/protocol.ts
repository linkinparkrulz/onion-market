export interface PlayerState { id: number; nym: string; code: string; x: number; y: number }
export interface RoomMap { w: number; h: number; blocked: string[] }

export interface Portal {
  tile: string;
  name: string;
  onion: string;
  desc: string;
}

export type ServerMsg =
  | { t: 'init'; you: number; map: RoomMap; players: PlayerState[]; portals?: Portal[]; ssoToken?: string }
  | { t: 'join'; player: PlayerState }
  | { t: 'leave'; id: number }
  | { t: 'state'; players: PlayerState[] }
  | { t: 'chat'; id: number; nym: string; text: string };

export type ClientMsg =
  | { t: 'move'; x: number; y: number }
  | { t: 'chat'; text: string };

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
