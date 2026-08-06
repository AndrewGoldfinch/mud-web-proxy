// SPDX-License-Identifier: GPL-3.0-or-later
export interface ProtocolConstants {
  WILL_ATCP: Buffer;
  WILL_GMCP: Buffer;
  DO_GMCP: Buffer;
  DO_MSDP: Buffer;
  DO_MXP: Buffer;
  WILL_MXP: Buffer;
  START: Buffer;
  STOP: Buffer;
  WILL_TTYPE: Buffer;
  WILL_NEW: Buffer;
  WONT_NAWS: Buffer;
  SGA: number;
  NEW: number;
  TTYPE: number;
  MSDP: number;
  MSDP_VAR: number;
  MSDP_VAL: number;
  MXP: number;
  ATCP: number;
  GMCP: number;
  SE: number;
  SB: number;
  WILL: number;
  WONT: number;
  DO: number;
  DONT: number;
  IAC: number;
  IS: number;
  REQUEST: number;
  ECHO: number;
  VAR: number;
  ACCEPTED: number;
  REJECTED: number;
  CHARSET: number;
  ESC: number;
  NAWS: number;
  WILL_CHARSET: Buffer;
  WILL_UTF8: Buffer;
  ACCEPT_UTF8: Buffer;
}

export const PROTOCOL_CONSTANTS: ProtocolConstants = {
  WILL_ATCP: Buffer.from([255, 251, 200]),
  WILL_GMCP: Buffer.from([255, 251, 201]),
  DO_GMCP: Buffer.from([255, 253, 201]),
  DO_MSDP: Buffer.from([255, 253, 69]),
  DO_MXP: Buffer.from([255, 253, 91]),
  WILL_MXP: Buffer.from([255, 251, 91]),
  START: Buffer.from([255, 250, 201]),
  STOP: Buffer.from([255, 240]),
  WILL_TTYPE: Buffer.from([255, 251, 24]),
  WILL_NEW: Buffer.from([255, 251, 39]),
  WONT_NAWS: Buffer.from([255, 252, 31]),
  SGA: 3,
  NEW: 39,
  TTYPE: 24,
  MSDP: 69,
  MSDP_VAR: 1,
  MSDP_VAL: 2,
  MXP: 91,
  ATCP: 200,
  GMCP: 201,
  SE: 240,
  SB: 250,
  WILL: 251,
  WONT: 252,
  DO: 253,
  DONT: 254,
  IAC: 255,
  IS: 0,
  REQUEST: 1,
  ECHO: 1,
  VAR: 1,
  ACCEPTED: 2,
  REJECTED: 3,
  CHARSET: 42,
  ESC: 27,
  NAWS: 31,
  WILL_CHARSET: Buffer.from([255, 251, 42]),
  WILL_UTF8: Buffer.from([255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240]),
  ACCEPT_UTF8: Buffer.from([255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240]),
};
