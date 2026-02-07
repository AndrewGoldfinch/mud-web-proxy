/**
 * Telnet Negotiation Tests - Part 1
 * Tests for TTYPE, GMCP, and MSDP protocol handlers
 */
import { describe, test, expect, beforeEach } from 'bun:test';
// Protocol constants
const PROTOCOL = {
    IAC: 255,
    WILL: 251,
    WONT: 252,
    DO: 253,
    DONT: 254,
    SB: 250,
    SE: 240,
    IS: 0,
    REQUEST: 1,
    TTYPE: 24,
    GMCP: 201,
    MSDP: 69,
    MSDP_VAR: 1,
    MSDP_VAL: 2,
    MXP: 91,
    MCCP2: 86,
    NAWS: 31,
    SGA: 3,
    NEW: 39,
    ECHO: 1,
    CHARSET: 42,
};
// Test utilities
function createMockSocket(overrides = {}) {
    return {
        req: {
            connection: { remoteAddress: '127.0.0.1' },
        },
        ts: undefined,
        host: 'localhost',
        port: 7000,
        ttype: [],
        name: 'TestUser',
        client: 'test-client',
        mccp: false,
        utf8: false,
        debug: false,
        compressed: 0,
        mccp_negotiated: 0,
        mxp_negotiated: 0,
        gmcp_negotiated: 0,
        utf8_negotiated: 0,
        new_negotiated: 0,
        new_handshake: 0,
        sga_negotiated: 0,
        echo_negotiated: 0,
        naws_negotiated: 0,
        msdp_negotiated: 0,
        chat: 0,
        password_mode: false,
        sendUTF: () => { },
        terminate: () => { },
        remoteAddress: '127.0.0.1',
        ...overrides,
    };
}
function createMockTelnetSocket(overrides = {}) {
    return {
        write: () => true,
        send: () => { },
        writable: true,
        ...overrides,
    };
}
// Helper to create protocol buffers
function createIACSequence(command, option) {
    return Buffer.from([PROTOCOL.IAC, command, option]);
}
function createSubnegotiation(option, ...data) {
    return Buffer.from([
        PROTOCOL.IAC,
        PROTOCOL.SB,
        option,
        ...data,
        PROTOCOL.IAC,
        PROTOCOL.SE,
    ]);
}
// Mock server implementation
class MockServer {
    prt = {
        WILL_TTYPE: Buffer.from([PROTOCOL.IAC, PROTOCOL.WILL, PROTOCOL.TTYPE]),
        WILL_GMCP: Buffer.from([PROTOCOL.IAC, PROTOCOL.WILL, PROTOCOL.GMCP]),
        DO_GMCP: Buffer.from([PROTOCOL.IAC, PROTOCOL.DO, PROTOCOL.GMCP]),
        DO_MSDP: Buffer.from([PROTOCOL.IAC, PROTOCOL.DO, PROTOCOL.MSDP]),
        DO_MCCP: Buffer.from([PROTOCOL.IAC, PROTOCOL.DO, PROTOCOL.MCCP2]),
        START: Buffer.from([PROTOCOL.IAC, PROTOCOL.SB, PROTOCOL.GMCP]),
        STOP: Buffer.from([PROTOCOL.IAC, PROTOCOL.SE]),
        IAC: PROTOCOL.IAC,
        SB: PROTOCOL.SB,
        SE: PROTOCOL.SE,
        WILL: PROTOCOL.WILL,
        DO: PROTOCOL.DO,
        WONT: PROTOCOL.WONT,
        IS: PROTOCOL.IS,
        REQUEST: PROTOCOL.REQUEST,
        TTYPE: PROTOCOL.TTYPE,
        GMCP: PROTOCOL.GMCP,
        MSDP: PROTOCOL.MSDP,
        MSDP_VAR: PROTOCOL.MSDP_VAR,
        MSDP_VAL: PROTOCOL.MSDP_VAL,
        MXP: PROTOCOL.MXP,
        MCCP2: PROTOCOL.MCCP2,
        NAWS: PROTOCOL.NAWS,
        SGA: PROTOCOL.SGA,
        NEW: PROTOCOL.NEW,
        ECHO: PROTOCOL.ECHO,
        CHARSET: PROTOCOL.CHARSET,
    };
    ttype = {
        enabled: 1,
        portal: ['maldorne.org', 'XTERM-256color', 'MTTS 141'],
    };
    gmcp = {
        enabled: 1,
        portal: ['client maldorne.org', 'client_version 1.0'],
    };
    debug = false;
    compress = false;
    // Store all writes for verification
    writes = [];
    sendTTYPE(s, msg) {
        if (msg && s.ts) {
            const p = this.prt;
            this.recordWrite(s, p.WILL_TTYPE);
            this.recordWrite(s, Buffer.from([p.IAC, p.SB, p.TTYPE, p.IS]));
            this.recordWrite(s, Buffer.from(msg));
            this.recordWrite(s, Buffer.from([p.IAC, p.SE]));
        }
    }
    sendGMCP(s, msg) {
        if (s.ts) {
            this.recordWrite(s, this.prt.START);
            this.recordWrite(s, Buffer.from(msg));
            this.recordWrite(s, this.prt.STOP);
        }
    }
    sendMSDP(s, msdp) {
        const p = this.prt;
        if (!msdp.key || !msdp.val || !s.ts)
            return;
        this.recordWrite(s, Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
        this.recordWrite(s, Buffer.from(msdp.key));
        const values = Array.isArray(msdp.val) ? msdp.val : [msdp.val];
        for (const val of values) {
            this.recordWrite(s, Buffer.from([p.MSDP_VAL]));
            this.recordWrite(s, Buffer.from(val));
        }
        this.recordWrite(s, Buffer.from([p.IAC, p.SE]));
    }
    sendMSDPPair(s, key, val) {
        const p = this.prt;
        if (!s.ts)
            return;
        this.recordWrite(s, Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
        this.recordWrite(s, Buffer.from(key));
        this.recordWrite(s, Buffer.from([p.MSDP_VAL]));
        this.recordWrite(s, Buffer.from(val));
        this.recordWrite(s, Buffer.from([p.IAC, p.SE]));
    }
    recordWrite(s, data) {
        this.writes.push({ socket: s, data });
        if (s.ts) {
            s.ts.write(data);
        }
    }
    sendClient(s, data) {
        const p = this.prt;
        // TTYPE Negotiation
        if (s.ttype.length) {
            for (let i = 0; i < data.length; i++) {
                if (data[i] === p.IAC &&
                    data[i + 1] === p.DO &&
                    data[i + 2] === p.TTYPE) {
                    this.sendTTYPE(s, s.ttype.shift());
                }
                else if (data[i] === p.IAC &&
                    data[i + 1] === p.SB &&
                    data[i + 2] === p.TTYPE &&
                    data[i + 3] === p.REQUEST) {
                    this.sendTTYPE(s, s.ttype.shift());
                }
            }
        }
        // GMCP Negotiation
        if (!s.gmcp_negotiated) {
            for (let i = 0; i < data.length; i++) {
                if (data[i] === p.IAC &&
                    (data[i + 1] === p.DO || data[i + 1] === p.WILL) &&
                    data[i + 2] === p.GMCP) {
                    if (data[i + 1] === p.DO) {
                        this.recordWrite(s, p.WILL_GMCP);
                    }
                    else {
                        this.recordWrite(s, p.DO_GMCP);
                    }
                    s.gmcp_negotiated = 1;
                    // Send portal messages
                    for (let t = 0; t < this.gmcp.portal.length; t++) {
                        if (t === 0 && s.client) {
                            this.sendGMCP(s, `client ${s.client}`);
                            continue;
                        }
                        this.sendGMCP(s, this.gmcp.portal[t]);
                    }
                    // Send client IP
                    this.sendGMCP(s, `client_ip ${s.remoteAddress}`);
                }
            }
        }
        // MSDP Negotiation
        if (!s.msdp_negotiated) {
            for (let i = 0; i < data.length; i++) {
                if (data[i] === p.IAC &&
                    data[i + 1] === p.WILL &&
                    data[i + 2] === p.MSDP) {
                    this.recordWrite(s, p.DO_MSDP);
                    this.sendMSDPPair(s, 'CLIENT_ID', s.client || 'mudportal.com');
                    this.sendMSDPPair(s, 'CLIENT_VERSION', '1.0');
                    this.sendMSDPPair(s, 'CLIENT_IP', s.remoteAddress);
                    this.sendMSDPPair(s, 'XTERM_256_COLORS', '1');
                    this.sendMSDPPair(s, 'MXP', '1');
                    this.sendMSDPPair(s, 'UTF_8', '1');
                    s.msdp_negotiated = 1;
                }
            }
        }
    }
    clearWrites() {
        this.writes = [];
    }
}
describe('Telnet Negotiation Handlers - Part 1', () => {
    let srv;
    let mockSocket;
    let mockTelnetSocket;
    beforeEach(() => {
        srv = new MockServer();
        mockTelnetSocket = createMockTelnetSocket();
        mockSocket = createMockSocket({
            ts: mockTelnetSocket,
            ttype: ['xterm-256color', 'screen-256color', 'linux'],
        });
    });
    describe('TTYPE (Terminal Type) Negotiation', () => {
        test('IAC DO TTYPE response with IAC WILL TTYPE', () => {
            // Simulate server sending IAC DO TTYPE
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.TTYPE);
            srv.sendClient(mockSocket, data);
            // Verify WILL TTYPE was sent
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBeGreaterThan(0);
            const willTTYPE = writes.find((w) => w.data.length === 3 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.TTYPE);
            expect(willTTYPE).toBeDefined();
        });
        test('IAC SB TTYPE REQUEST response with terminal type', () => {
            // Simulate server sending IAC SB TTYPE REQUEST
            const data = createSubnegotiation(PROTOCOL.TTYPE, PROTOCOL.REQUEST);
            const originalTType = mockSocket.ttype[0];
            srv.sendClient(mockSocket, data);
            // Verify terminal type was sent in subnegotiation
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Check for IAC SB TTYPE IS <terminal_type> IAC SE sequence
            let foundSubnegotiation = false;
            for (let i = 0; i < writes.length - 1; i++) {
                if (writes[i].data[0] === PROTOCOL.IAC &&
                    writes[i].data[1] === PROTOCOL.SB &&
                    writes[i].data[2] === PROTOCOL.TTYPE &&
                    writes[i].data[3] === PROTOCOL.IS) {
                    foundSubnegotiation = true;
                    // Next write should be the terminal type
                    const termTypeWrite = writes[i + 1];
                    expect(termTypeWrite).toBeDefined();
                    expect(termTypeWrite.data.toString()).toBe(originalTType);
                    break;
                }
            }
            expect(foundSubnegotiation).toBe(true);
        });
        test('Terminal type queue management - shift from ttype array', () => {
            const originalLength = mockSocket.ttype.length;
            expect(originalLength).toBe(3);
            expect(mockSocket.ttype[0]).toBe('xterm-256color');
            // First request
            const data1 = createIACSequence(PROTOCOL.DO, PROTOCOL.TTYPE);
            srv.sendClient(mockSocket, data1);
            // Terminal type should be shifted
            expect(mockSocket.ttype.length).toBe(originalLength - 1);
            expect(mockSocket.ttype[0]).toBe('screen-256color');
            // Second request
            srv.clearWrites();
            const data2 = createSubnegotiation(PROTOCOL.TTYPE, PROTOCOL.REQUEST);
            srv.sendClient(mockSocket, data2);
            // Should shift again
            expect(mockSocket.ttype.length).toBe(originalLength - 2);
            expect(mockSocket.ttype[0]).toBe('linux');
        });
        test('No terminal type sent when ttype array is empty', () => {
            mockSocket.ttype = [];
            srv.clearWrites();
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.TTYPE);
            srv.sendClient(mockSocket, data);
            // Verify no TTYPE negotiation occurred
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            const ttypeWrites = writes.filter((w) => w.data[0] === PROTOCOL.IAC &&
                (w.data[2] === PROTOCOL.TTYPE ||
                    (w.data[1] === PROTOCOL.SB && w.data[2] === PROTOCOL.TTYPE)));
            expect(ttypeWrites.length).toBe(0);
        });
    });
    describe('GMCP (Generic MUD Communication Protocol) Negotiation', () => {
        test('IAC DO GMCP response with IAC WILL GMCP', () => {
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            // Verify WILL GMCP was sent
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            const willGMCP = writes.find((w) => w.data.length === 3 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.GMCP);
            expect(willGMCP).toBeDefined();
        });
        test('IAC WILL GMCP response with IAC DO GMCP', () => {
            const data = createIACSequence(PROTOCOL.WILL, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            // Verify DO GMCP was sent
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            const doGMCP = writes.find((w) => w.data.length === 3 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.DO &&
                w.data[2] === PROTOCOL.GMCP);
            expect(doGMCP).toBeDefined();
        });
        test('GMCP negotiation flag is set correctly', () => {
            expect(mockSocket.gmcp_negotiated).toBe(0);
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            expect(mockSocket.gmcp_negotiated).toBe(1);
        });
        test('GMCP portal messages sent after negotiation', () => {
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            // Verify portal messages were sent
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Check for GMCP START and STOP sequences
            const gmcpMessages = [];
            for (let i = 0; i < writes.length - 1; i++) {
                if (writes[i].data[0] === PROTOCOL.IAC &&
                    writes[i].data[1] === PROTOCOL.SB &&
                    writes[i].data[2] === PROTOCOL.GMCP) {
                    // Found START, message should be in next write
                    if (writes[i + 1]) {
                        gmcpMessages.push(writes[i + 1].data.toString());
                    }
                }
            }
            // Should have portal messages
            expect(gmcpMessages.length).toBeGreaterThan(0);
            // First message should be client info (using socket's client value)
            expect(gmcpMessages[0]).toBe('client test-client');
            // Other portal messages should follow
            expect(gmcpMessages).toContain('client_version 1.0');
        });
        test('Client IP sent via GMCP', () => {
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            const gmcpMessages = [];
            for (let i = 0; i < writes.length - 1; i++) {
                if (writes[i].data[0] === PROTOCOL.IAC &&
                    writes[i].data[1] === PROTOCOL.SB &&
                    writes[i].data[2] === PROTOCOL.GMCP) {
                    if (writes[i + 1]) {
                        gmcpMessages.push(writes[i + 1].data.toString());
                    }
                }
            }
            // Should contain client_ip message
            const clientIPMessage = gmcpMessages.find((m) => m.startsWith('client_ip '));
            expect(clientIPMessage).toBeDefined();
            expect(clientIPMessage).toBe('client_ip 127.0.0.1');
        });
        test('No duplicate GMCP negotiation', () => {
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            // First negotiation
            srv.sendClient(mockSocket, data);
            const firstWriteCount = srv.writes.length;
            // Second negotiation attempt (should be ignored)
            srv.sendClient(mockSocket, data);
            const secondWriteCount = srv.writes.length;
            // Should not send additional GMCP messages
            expect(secondWriteCount).toBe(firstWriteCount);
        });
    });
    describe('MSDP (MUD Server Data Protocol) Negotiation', () => {
        test('IAC WILL MSDP response with IAC DO MSDP', () => {
            const data = createIACSequence(PROTOCOL.WILL, PROTOCOL.MSDP);
            srv.sendClient(mockSocket, data);
            // Verify DO MSDP was sent
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            const doMSDP = writes.find((w) => w.data.length === 3 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.DO &&
                w.data[2] === PROTOCOL.MSDP);
            expect(doMSDP).toBeDefined();
        });
        test('MSDP negotiation flag is set correctly', () => {
            expect(mockSocket.msdp_negotiated).toBe(0);
            const data = createIACSequence(PROTOCOL.WILL, PROTOCOL.MSDP);
            srv.sendClient(mockSocket, data);
            expect(mockSocket.msdp_negotiated).toBe(1);
        });
        test('MSDP variable/value pairs sent correctly after negotiation', () => {
            const data = createIACSequence(PROTOCOL.WILL, PROTOCOL.MSDP);
            srv.sendClient(mockSocket, data);
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Check for MSDP subnegotiations
            const msdpSubnegotiations = [];
            for (let i = 0; i < writes.length; i++) {
                if (writes[i].data[0] === PROTOCOL.IAC &&
                    writes[i].data[1] === PROTOCOL.SB &&
                    writes[i].data[2] === PROTOCOL.MSDP) {
                    // Collect the entire subnegotiation
                    const subneg = [writes[i]];
                    // Include following writes until IAC SE
                    for (let j = i + 1; j < writes.length; j++) {
                        subneg.push(writes[j]);
                        if (writes[j].data[0] === PROTOCOL.IAC &&
                            writes[j].data[1] === PROTOCOL.SE) {
                            break;
                        }
                    }
                    msdpSubnegotiations.push(subneg);
                }
            }
            // Should have sent multiple MSDP pairs
            expect(msdpSubnegotiations.length).toBeGreaterThan(0);
            // Verify CLIENT_ID was sent
            const clientIdSubneg = msdpSubnegotiations.find((sub) => {
                return sub.some((w) => w.data.toString() === 'CLIENT_ID');
            });
            expect(clientIdSubneg).toBeDefined();
            // Verify CLIENT_IP was sent
            const clientIPSubneg = msdpSubnegotiations.find((sub) => {
                return sub.some((w) => w.data.toString() === 'CLIENT_IP');
            });
            expect(clientIPSubneg).toBeDefined();
        });
    });
    describe('sendMSDP function', () => {
        beforeEach(() => {
            srv.clearWrites();
        });
        test('sendMSDP with single value', () => {
            srv.sendMSDP(mockSocket, { key: 'TEST_VAR', val: 'test_value' });
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Should write: IAC SB MSDP VAR <key> VAL <value> IAC SE
            expect(writes.length).toBe(5);
            // First write: IAC SB MSDP VAR
            expect(writes[0].data).toEqual(Buffer.from([
                PROTOCOL.IAC,
                PROTOCOL.SB,
                PROTOCOL.MSDP,
                PROTOCOL.MSDP_VAR,
            ]));
            // Second write: key
            expect(writes[1].data.toString()).toBe('TEST_VAR');
            // Third write: VAL
            expect(writes[2].data).toEqual(Buffer.from([PROTOCOL.MSDP_VAL]));
            // Fourth write: value
            expect(writes[3].data.toString()).toBe('test_value');
            // Fifth write: IAC SE
            expect(writes[4].data).toEqual(Buffer.from([PROTOCOL.IAC, PROTOCOL.SE]));
        });
        test('sendMSDP with array of values', () => {
            srv.sendMSDP(mockSocket, {
                key: 'ARRAY_VAR',
                val: ['value1', 'value2', 'value3'],
            });
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Should write multiple VAL entries
            let valCount = 0;
            for (const write of writes) {
                if (write.data.length === 1 && write.data[0] === PROTOCOL.MSDP_VAL) {
                    valCount++;
                }
            }
            expect(valCount).toBe(3);
        });
        test('sendMSDP does nothing when key is missing', () => {
            srv.sendMSDP(mockSocket, { val: 'value_without_key' });
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBe(0);
        });
        test('sendMSDP does nothing when val is missing', () => {
            srv.sendMSDP(mockSocket, { key: 'key_without_value' });
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBe(0);
        });
        test('sendMSDP does nothing when ts is undefined', () => {
            mockSocket.ts = undefined;
            srv.sendMSDP(mockSocket, { key: 'TEST', val: 'value' });
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBe(0);
        });
    });
    describe('sendMSDPPair function', () => {
        beforeEach(() => {
            srv.clearWrites();
        });
        test('sendMSDPPair sends correct sequence', () => {
            srv.sendMSDPPair(mockSocket, 'MY_VAR', 'my_value');
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBe(5);
            // IAC SB MSDP VAR
            expect(writes[0].data).toEqual(Buffer.from([
                PROTOCOL.IAC,
                PROTOCOL.SB,
                PROTOCOL.MSDP,
                PROTOCOL.MSDP_VAR,
            ]));
            // Key
            expect(writes[1].data.toString()).toBe('MY_VAR');
            // VAL
            expect(writes[2].data).toEqual(Buffer.from([PROTOCOL.MSDP_VAL]));
            // Value
            expect(writes[3].data.toString()).toBe('my_value');
            // IAC SE
            expect(writes[4].data).toEqual(Buffer.from([PROTOCOL.IAC, PROTOCOL.SE]));
        });
        test('sendMSDPPair does nothing when ts is undefined', () => {
            mockSocket.ts = undefined;
            srv.sendMSDPPair(mockSocket, 'TEST', 'value');
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            expect(writes.length).toBe(0);
        });
        test('sendMSDPPair with empty values', () => {
            srv.sendMSDPPair(mockSocket, '', '');
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Should still write the sequence with empty strings
            expect(writes.length).toBe(5);
            expect(writes[1].data.toString()).toBe('');
            expect(writes[3].data.toString()).toBe('');
        });
    });
    describe('Protocol sequence verification', () => {
        test('Complete TTYPE negotiation sequence', () => {
            const data = createSubnegotiation(PROTOCOL.TTYPE, PROTOCOL.REQUEST);
            srv.sendClient(mockSocket, data);
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Verify complete sequence: IAC WILL TTYPE, IAC SB TTYPE IS <term>, IAC SE
            // Find the sequence parts across all writes
            const willTTYPEIndex = writes.findIndex((w) => w.data.length === 3 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.TTYPE);
            expect(willTTYPEIndex).toBeGreaterThanOrEqual(0);
            // Find SB TTYPE IS sequence
            const sbTTYPEIndex = writes.findIndex((w) => w.data.length === 4 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.SB &&
                w.data[2] === PROTOCOL.TTYPE &&
                w.data[3] === PROTOCOL.IS);
            expect(sbTTYPEIndex).toBeGreaterThanOrEqual(0);
            // Find terminal type (should be after SB TTYPE IS)
            expect(writes[sbTTYPEIndex + 1]).toBeDefined();
            expect(writes[sbTTYPEIndex + 1].data.toString()).toBe('xterm-256color');
            // Find IAC SE (should be after terminal type)
            const seIndex = writes.findIndex((w) => w.data.length === 2 &&
                w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.SE);
            expect(seIndex).toBeGreaterThanOrEqual(0);
            // Verify order: WILL TTYPE -> SB TTYPE IS -> term -> SE
            expect(sbTTYPEIndex).toBeGreaterThan(willTTYPEIndex);
            expect(seIndex).toBeGreaterThan(sbTTYPEIndex);
        });
        test('Complete GMCP negotiation sequence', () => {
            const data = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            srv.sendClient(mockSocket, data);
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Verify: IAC WILL GMCP, then portal messages with IAC SB GMCP ... IAC SE
            const willGMCP = writes.find((w) => w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.GMCP);
            expect(willGMCP).toBeDefined();
            // Check for portal messages
            let portalMessageCount = 0;
            for (let i = 0; i < writes.length - 2; i++) {
                if (writes[i].data[0] === PROTOCOL.IAC &&
                    writes[i].data[1] === PROTOCOL.SB &&
                    writes[i].data[2] === PROTOCOL.GMCP) {
                    // Found START, check for corresponding STOP
                    for (let j = i + 1; j < writes.length; j++) {
                        if (writes[j].data[0] === PROTOCOL.IAC &&
                            writes[j].data[1] === PROTOCOL.SE) {
                            portalMessageCount++;
                            break;
                        }
                    }
                }
            }
            expect(portalMessageCount).toBeGreaterThan(0);
        });
    });
    describe('Multiple negotiation scenarios', () => {
        test('TTYPE, GMCP, and MSDP all negotiate correctly', () => {
            // Set up ttype array
            mockSocket.ttype = ['terminal1', 'terminal2'];
            // Simulate server sending all three negotiations
            const ttypeData = createIACSequence(PROTOCOL.DO, PROTOCOL.TTYPE);
            const gmcpData = createIACSequence(PROTOCOL.DO, PROTOCOL.GMCP);
            const msdpData = createIACSequence(PROTOCOL.WILL, PROTOCOL.MSDP);
            // Combine into one buffer
            const combinedData = Buffer.concat([ttypeData, gmcpData, msdpData]);
            srv.sendClient(mockSocket, combinedData);
            // Verify all negotiations occurred
            expect(mockSocket.gmcp_negotiated).toBe(1);
            expect(mockSocket.msdp_negotiated).toBe(1);
            expect(mockSocket.ttype.length).toBe(1); // Shifted once
            // Verify all expected writes
            const writes = srv.writes.filter((w) => w.socket === mockSocket);
            // Should have TTYPE, GMCP, and MSDP responses
            const hasTTYPE = writes.some((w) => w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.TTYPE);
            const hasGMCP = writes.some((w) => w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.WILL &&
                w.data[2] === PROTOCOL.GMCP);
            const hasMSDP = writes.some((w) => w.data[0] === PROTOCOL.IAC &&
                w.data[1] === PROTOCOL.DO &&
                w.data[2] === PROTOCOL.MSDP);
            expect(hasTTYPE).toBe(true);
            expect(hasGMCP).toBe(true);
            expect(hasMSDP).toBe(true);
        });
    });
});
//# sourceMappingURL=telnet-negotiation-part1.test.js.map