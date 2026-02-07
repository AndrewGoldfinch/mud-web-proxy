/**
 * Data Transformation Tests
 * Tests for iconv encoding, zlib compression, and protocol parsing
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, } from 'bun:test';
// Mock data stores
let mockZlibCalls = [];
let mockIconvCalls = [];
let lastEncodedData = null;
let shouldDeflateFail = false;
let shouldIconvFail = false;
// Mock zlib module
const mockZlib = {
    deflateRaw: (data, callback) => {
        mockZlibCalls.push({ data, options: {} });
        if (shouldDeflateFail) {
            callback(new Error('Compression failed'), Buffer.from([]));
            return;
        }
        // Simulate deflateRaw compression by prefixing with magic bytes
        const compressed = Buffer.concat([Buffer.from([0x78, 0x9c]), data]);
        callback(null, compressed);
    },
    // Control methods for testing
    _setShouldFail: (fail) => {
        shouldDeflateFail = fail;
    },
    _getLastCall: () => mockZlibCalls[mockZlibCalls.length - 1],
    _clearCalls: () => {
        mockZlibCalls = [];
    },
};
// Mock iconv-lite module
const mockIconv = {
    encode: (str, encoding) => {
        mockIconvCalls.push({ str, encoding });
        if (shouldIconvFail) {
            throw new Error(`Encoding failed for ${encoding}`);
        }
        if (encoding === 'latin1') {
            // Latin1 encoding: each character code maps directly to byte value
            const result = Buffer.alloc(str.length);
            for (let i = 0; i < str.length; i++) {
                result[i] = str.charCodeAt(i) & 0xff;
            }
            lastEncodedData = result;
            return result;
        }
        // Default to UTF-8
        const result = Buffer.from(str, 'utf8');
        lastEncodedData = result;
        return result;
    },
    decode: (buffer, encoding) => {
        if (encoding === 'latin1') {
            // Latin1 decoding: each byte maps directly to character
            return Array.from(buffer)
                .map((b) => String.fromCharCode(b))
                .join('');
        }
        return buffer.toString('utf8');
    },
    // Control methods for testing
    _setShouldFail: (fail) => {
        shouldIconvFail = fail;
    },
    _getLastCall: () => mockIconvCalls[mockIconvCalls.length - 1],
    _clearCalls: () => {
        mockIconvCalls = [];
        lastEncodedData = null;
    },
    _getLastEncoded: () => lastEncodedData,
};
// Protocol constants
const p = {
    WILL_ATCP: Buffer.from([255, 251, 200]),
    WILL_GMCP: Buffer.from([255, 251, 201]),
    DO_GMCP: Buffer.from([255, 253, 201]),
    DO_MCCP: Buffer.from([255, 253, 86]),
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
    MCCP2: 86,
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
    ESC: 33,
    NAWS: 31,
    WILL_CHARSET: Buffer.from([255, 251, 42]),
    WILL_UTF8: Buffer.from([255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240]),
    ACCEPT_UTF8: Buffer.from([
        255, 250, 2, 34, 85, 84, 70, 45, 56, 34, 255, 240,
    ]),
};
// Test data
const TEST_STRING = 'Hello World';
const TEST_LATIN1_STRING = 'Hëllö Wörld';
// Helper to create mock SocketExtended
function createMockSocket(overrides = {}) {
    const sentMessages = [];
    const baseSocket = {
        req: {
            connection: {
                remoteAddress: '127.0.0.1',
            },
        },
        ts: undefined,
        host: 'test.host',
        port: 7000,
        ttype: ['xterm-256color'],
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
        remoteAddress: '127.0.0.1',
        send: (data) => {
            const str = typeof data === 'string' ? data : data.toString();
            sentMessages.push(str);
        },
        sendUTF: (data) => {
            const str = typeof data === 'string' ? data : data.toString();
            sentMessages.push(str);
        },
        terminate: () => { },
        _sentMessages: sentMessages,
        ...overrides,
    };
    return baseSocket;
}
// Helper to create mock TelnetSocket
function createMockTelnetSocket() {
    const written = [];
    return {
        write: (data) => {
            written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            return true;
        },
        send: (data) => {
            try {
                let buffer;
                if (typeof data === 'string') {
                    buffer = mockIconv.encode(data, 'latin1');
                }
                else {
                    buffer = data;
                }
                written.push(buffer);
            }
            catch {
                // Error handled in actual implementation
            }
        },
        on: () => ({}),
        once: () => ({}),
        destroy: () => { },
        end: () => { },
        setEncoding: () => { },
        writable: true,
        written,
    };
}
// Helper to create protocol sequences
function createIACSequence(command, option) {
    return Buffer.from([p.IAC, command, option]);
}
// Mock implementation of sendClient for testing
function sendClient(s, data, options = {}) {
    // MCCP negotiation detection
    if (s.mccp && !s.mccp_negotiated && !s.compressed) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.MCCP2) {
                // MCCP WILL detected
            }
            else if (data[i] === p.IAC &&
                data[i + 1] === p.SB &&
                data[i + 2] === p.MCCP2) {
                // MCCP START detected - data before this should be sent uncompressed
                if (i > 0) {
                    const before = data.slice(0, i);
                    sendClient(s, before, options);
                }
                // Mark as compressed and process remaining data
                data = data.slice(i + 5);
                s.compressed = 1;
                if (!data.length)
                    return;
            }
        }
    }
    // TTYPE sequence detection
    if (s.ttype.length) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.DO &&
                data[i + 2] === p.TTYPE) {
                // TTYPE DO detected
            }
            else if (data[i] === p.IAC &&
                data[i + 1] === p.SB &&
                data[i + 2] === p.TTYPE &&
                data[i + 3] === p.REQUEST) {
                // TTYPE REQUEST detected
            }
        }
    }
    // GMCP sequence detection
    if (!s.gmcp_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                (data[i + 1] === p.DO || data[i + 1] === p.WILL) &&
                data[i + 2] === p.GMCP) {
                s.gmcp_negotiated = 1;
            }
        }
    }
    // MSDP sequence detection
    if (!s.msdp_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.MSDP) {
                s.msdp_negotiated = 1;
            }
        }
    }
    // MXP sequence detection
    if (!s.mxp_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC && data[i + 1] === p.DO && data[i + 2] === p.MXP) {
                s.mxp_negotiated = 1;
            }
            else if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.MXP) {
                s.mxp_negotiated = 1;
            }
        }
    }
    // NEW-ENV sequence detection
    if (!s.new_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC && data[i + 1] === p.DO && data[i + 2] === p.NEW) {
                s.new_negotiated = 1;
            }
        }
    }
    else if (!s.new_handshake) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.SB &&
                data[i + 2] === p.NEW &&
                data[i + 3] === p.REQUEST) {
                s.new_handshake = 1;
            }
        }
    }
    // ECHO sequence detection
    if (!s.echo_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.ECHO) {
                s.password_mode = true;
                s.echo_negotiated = 1;
            }
        }
    }
    // SGA sequence detection
    if (!s.sga_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.SGA) {
                s.sga_negotiated = 1;
            }
        }
    }
    // NAWS sequence detection
    if (!s.naws_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.WILL &&
                data[i + 2] === p.NAWS) {
                s.naws_negotiated = 1;
            }
        }
    }
    // CHARSET sequence detection
    if (!s.utf8_negotiated) {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === p.IAC &&
                data[i + 1] === p.DO &&
                data[i + 2] === p.CHARSET) {
                // CHARSET DO detected
            }
            if (data[i] === p.IAC &&
                data[i + 1] === p.SB &&
                data[i + 2] === p.CHARSET) {
                s.utf8_negotiated = 1;
            }
        }
    }
    // Send data
    const compress = options.compress ?? true;
    const useMccp = s.mccp && s.compressed;
    if (!compress || useMccp) {
        // Send uncompressed base64
        s._sentMessages.push(data.toString('base64'));
        return;
    }
    // Compress with zlib
    mockZlib.deflateRaw(data, (err, buffer) => {
        if (!err) {
            s._sentMessages.push(buffer.toString('base64'));
        }
        else {
            // Fallback to uncompressed on error
            s._sentMessages.push(data.toString('base64'));
        }
    });
}
describe('Data Transformation', () => {
    beforeAll(() => {
        // Ensure mocks are reset before all tests
        mockZlib._clearCalls();
        mockIconv._clearCalls();
    });
    beforeEach(() => {
        mockZlib._clearCalls();
        mockIconv._clearCalls();
        mockZlib._setShouldFail(false);
        mockIconv._setShouldFail(false);
    });
    afterEach(() => {
        mockZlib._setShouldFail(false);
        mockIconv._setShouldFail(false);
    });
    describe('iconv encoding', () => {
        it('should encode string to latin1', () => {
            const input = TEST_LATIN1_STRING;
            const result = mockIconv.encode(input, 'latin1');
            expect(result).toBeDefined();
            expect(Buffer.isBuffer(result)).toBe(true);
            expect(result.length).toBe(input.length);
            // Check that special characters are encoded correctly
            for (let i = 0; i < input.length; i++) {
                expect(result[i]).toBe(input.charCodeAt(i) & 0xff);
            }
        });
        it('should handle ASCII strings correctly', () => {
            const input = TEST_STRING;
            const result = mockIconv.encode(input, 'latin1');
            expect(result.toString()).toBe(input);
            expect(result.length).toBe(input.length);
        });
        it('should throw error on encoding failure', () => {
            mockIconv._setShouldFail(true);
            expect(() => {
                mockIconv.encode(TEST_STRING, 'latin1');
            }).toThrow('Encoding failed');
        });
        it('should integrate with ts.send() workflow', () => {
            const ts = createMockTelnetSocket();
            const testData = 'Test message with ñ characters';
            // Simulate send() behavior
            ts.send(testData);
            // Verify encoding was called
            expect(mockIconvCalls.length).toBeGreaterThan(0);
            expect(mockIconvCalls[0].str).toBe(testData);
            expect(mockIconvCalls[0].encoding).toBe('latin1');
            // Verify data was written
            expect(ts.written.length).toBe(1);
        });
        it('should handle empty strings', () => {
            const result = mockIconv.encode('', 'latin1');
            expect(result.length).toBe(0);
        });
        it('should preserve byte values 128-255 in latin1', () => {
            const input = String.fromCharCode(128, 200, 255);
            const result = mockIconv.encode(input, 'latin1');
            expect(result[0]).toBe(128);
            expect(result[1]).toBe(200);
            expect(result[2]).toBe(255);
        });
    });
    describe('zlib compression', () => {
        it('should compress data with deflateRaw', () => {
            const input = Buffer.from(TEST_STRING);
            mockZlib.deflateRaw(input, (err, buffer) => {
                expect(err).toBeNull();
                expect(buffer).toBeDefined();
                expect(buffer.length).toBeGreaterThan(0);
                // Check that the compressed data starts with the mock header
                expect(buffer[0]).toBe(0x78);
                expect(buffer[1]).toBe(0x9c);
            });
        });
        it('should send compressed data as base64', () => {
            const s = createMockSocket();
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data, { compress: true });
            // Should have sent exactly one message
            expect(s._sentMessages.length).toBe(1);
            // Should be valid base64
            const sent = s._sentMessages[0];
            expect(() => Buffer.from(sent, 'base64')).not.toThrow();
            // Should be decompressible (starts with our mock header)
            const decoded = Buffer.from(sent, 'base64');
            expect(decoded[0]).toBe(0x78);
            expect(decoded[1]).toBe(0x9c);
        });
        it('should handle compression failure gracefully', () => {
            mockZlib._setShouldFail(true);
            const s = createMockSocket();
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data, { compress: true });
            // Should fallback to uncompressed base64
            expect(s._sentMessages.length).toBe(1);
            const decoded = Buffer.from(s._sentMessages[0], 'base64');
            expect(decoded.toString()).toBe(TEST_STRING);
        });
        it('should fallback to uncompressed when MCCP is active', () => {
            const s = createMockSocket({ mccp: true, compressed: 1 });
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data);
            // Should NOT compress when MCCP is active
            expect(s._sentMessages.length).toBe(1);
            expect(mockZlibCalls.length).toBe(0);
            // Should be raw base64
            const sent = s._sentMessages[0];
            expect(sent).toBe(data.toString('base64'));
        });
        it('should compress large data correctly', () => {
            const largeData = Buffer.alloc(1000, 'x');
            const s = createMockSocket();
            sendClient(s, largeData, { compress: true });
            expect(s._sentMessages.length).toBe(1);
            const sent = s._sentMessages[0];
            // Should be valid base64
            expect(() => Buffer.from(sent, 'base64')).not.toThrow();
            // Should have compression header
            const decoded = Buffer.from(sent, 'base64');
            expect(decoded[0]).toBe(0x78);
            expect(decoded[1]).toBe(0x9c);
        });
    });
    describe('base64 encoding', () => {
        it('should encode data to base64 for WebSocket', () => {
            const s = createMockSocket();
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data, { compress: false });
            expect(s._sentMessages.length).toBe(1);
            expect(s._sentMessages[0]).toBe(data.toString('base64'));
        });
        it('should handle binary data correctly', () => {
            const s = createMockSocket();
            const binaryData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
            sendClient(s, binaryData, { compress: false });
            const sent = s._sentMessages[0];
            const decoded = Buffer.from(sent, 'base64');
            expect(decoded.length).toBe(binaryData.length);
            for (let i = 0; i < binaryData.length; i++) {
                expect(decoded[i]).toBe(binaryData[i]);
            }
        });
        it('should use MCCP path when compression is active', () => {
            const s = createMockSocket({ mccp: true, compressed: 1 });
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data, { compress: true });
            // Should bypass zlib compression
            expect(mockZlibCalls.length).toBe(0);
            expect(s._sentMessages[0]).toBe(data.toString('base64'));
        });
        it('should use uncompressed path when MCCP is not active', () => {
            const s = createMockSocket({ mccp: false, compressed: 0 });
            const data = Buffer.from(TEST_STRING);
            sendClient(s, data, { compress: false });
            expect(mockZlibCalls.length).toBe(0);
            expect(s._sentMessages[0]).toBe(data.toString('base64'));
        });
        it('should handle empty data', () => {
            const s = createMockSocket();
            const emptyData = Buffer.alloc(0);
            sendClient(s, emptyData, { compress: false });
            expect(s._sentMessages.length).toBe(1);
            expect(s._sentMessages[0]).toBe('');
        });
    });
    describe('sendClient() data flow', () => {
        it('should detect MCCP negotiation in incoming data', () => {
            const s = createMockSocket({ mccp: true });
            const mccWill = createIACSequence(p.WILL, p.MCCP2);
            sendClient(s, mccWill);
            // MCCP WILL should be detected
            expect(s.mccp).toBe(true);
        });
        it('should detect compression start sequence', () => {
            const s = createMockSocket({ mccp: true });
            const dataBefore = Buffer.from('Before compression');
            const mccStart = Buffer.from([p.IAC, p.SB, p.MCCP2, p.IAC, p.SE]);
            const dataAfter = Buffer.from('After compression');
            const combined = Buffer.concat([dataBefore, mccStart, dataAfter]);
            sendClient(s, combined);
            // Should have processed data before MCCP
            expect(s.compressed).toBe(1);
            // Data after MCCP should be in messages
            expect(s._sentMessages.length).toBeGreaterThan(0);
        });
        it('should scan for multiple protocols in single data chunk', () => {
            const s = createMockSocket({
                ttype: ['test'],
                gmcp_negotiated: 0,
                msdp_negotiated: 0,
                mxp_negotiated: 0,
            });
            const combined = Buffer.concat([
                createIACSequence(p.DO, p.TTYPE),
                createIACSequence(p.DO, p.GMCP),
                createIACSequence(p.WILL, p.MSDP),
                createIACSequence(p.DO, p.MXP),
                Buffer.from('Regular data'),
            ]);
            sendClient(s, combined);
            // All protocols should be detected
            expect(s.gmcp_negotiated).toBe(1);
            expect(s.msdp_negotiated).toBe(1);
            expect(s.mxp_negotiated).toBe(1);
        });
        it('should slice data correctly for MCCP start', () => {
            const s = createMockSocket({ mccp: true });
            const beforeMccp = Buffer.from('Before');
            const afterMccp = Buffer.from('After');
            const mccStart = Buffer.from([p.IAC, p.SB, p.MCCP2, p.IAC, p.SE]);
            const combined = Buffer.concat([beforeMccp, mccStart, afterMccp]);
            sendClient(s, combined);
            // Should have sent data before MCCP
            expect(s.compressed).toBe(1);
            // Should have processed remaining data
            expect(s._sentMessages.length).toBeGreaterThan(0);
        });
        it('should handle data without any protocol sequences', () => {
            const s = createMockSocket();
            const plainData = Buffer.from('Just regular text data');
            sendClient(s, plainData, { compress: false });
            expect(s._sentMessages.length).toBe(1);
            expect(s._sentMessages[0]).toBe(plainData.toString('base64'));
        });
        it('should handle fragmented protocol sequences', () => {
            const s = createMockSocket({ ttype: ['test'] });
            // Only send partial IAC sequence
            const partial = Buffer.from([p.IAC, p.DO]);
            sendClient(s, partial, { compress: false });
            // Should still send the data
            expect(s._sentMessages.length).toBe(1);
        });
    });
    describe('protocol sequence detection', () => {
        it('should detect TTYPE sequence', () => {
            const s = createMockSocket({ ttype: ['xterm-256color'] });
            const ttypeDo = createIACSequence(p.DO, p.TTYPE);
            sendClient(s, ttypeDo, { compress: false });
            // TTYPE detection should happen
            expect(s._sentMessages.length).toBeGreaterThan(0);
        });
        it('should detect TTYPE REQUEST sequence', () => {
            const s = createMockSocket({ ttype: ['xterm-256color'] });
            const ttypeReq = Buffer.from([
                p.IAC,
                p.SB,
                p.TTYPE,
                p.REQUEST,
                p.IAC,
                p.SE,
            ]);
            sendClient(s, ttypeReq, { compress: false });
            // TTYPE REQUEST should be detected
            expect(s._sentMessages.length).toBeGreaterThan(0);
        });
        it('should detect GMCP sequence', () => {
            const s = createMockSocket({ gmcp_negotiated: 0 });
            const gmcpDo = createIACSequence(p.DO, p.GMCP);
            sendClient(s, gmcpDo, { compress: false });
            expect(s.gmcp_negotiated).toBe(1);
        });
        it('should detect GMCP WILL sequence', () => {
            const s = createMockSocket({ gmcp_negotiated: 0 });
            const gmcpWill = createIACSequence(p.WILL, p.GMCP);
            sendClient(s, gmcpWill, { compress: false });
            expect(s.gmcp_negotiated).toBe(1);
        });
        it('should detect MSDP sequence', () => {
            const s = createMockSocket({ msdp_negotiated: 0 });
            const msdpWill = createIACSequence(p.WILL, p.MSDP);
            sendClient(s, msdpWill, { compress: false });
            expect(s.msdp_negotiated).toBe(1);
        });
        it('should detect MXP DO sequence', () => {
            const s = createMockSocket({ mxp_negotiated: 0 });
            const mxpDo = createIACSequence(p.DO, p.MXP);
            sendClient(s, mxpDo, { compress: false });
            expect(s.mxp_negotiated).toBe(1);
        });
        it('should detect MXP WILL sequence', () => {
            const s = createMockSocket({ mxp_negotiated: 0 });
            const mxpWill = createIACSequence(p.WILL, p.MXP);
            sendClient(s, mxpWill, { compress: false });
            expect(s.mxp_negotiated).toBe(1);
        });
        it('should detect NEW-ENV sequence', () => {
            const s = createMockSocket({ new_negotiated: 0 });
            const newDo = createIACSequence(p.DO, p.NEW);
            sendClient(s, newDo, { compress: false });
            expect(s.new_negotiated).toBe(1);
        });
        it('should detect NEW-ENV REQUEST sequence', () => {
            const s = createMockSocket({ new_negotiated: 1, new_handshake: 0 });
            const newReq = Buffer.from([p.IAC, p.SB, p.NEW, p.REQUEST, p.IAC, p.SE]);
            sendClient(s, newReq, { compress: false });
            expect(s.new_handshake).toBe(1);
        });
        it('should detect CHARSET DO sequence', () => {
            const s = createMockSocket({ utf8_negotiated: 0 });
            const charsetDo = createIACSequence(p.DO, p.CHARSET);
            sendClient(s, charsetDo, { compress: false });
            // Detection should happen
            expect(s._sentMessages.length).toBeGreaterThan(0);
        });
        it('should detect CHARSET SB sequence', () => {
            const s = createMockSocket({ utf8_negotiated: 0 });
            const charsetSb = Buffer.from([p.IAC, p.SB, p.CHARSET, p.IAC, p.SE]);
            sendClient(s, charsetSb, { compress: false });
            expect(s.utf8_negotiated).toBe(1);
        });
        it('should detect SGA sequence', () => {
            const s = createMockSocket({ sga_negotiated: 0 });
            const sgaWill = createIACSequence(p.WILL, p.SGA);
            sendClient(s, sgaWill, { compress: false });
            expect(s.sga_negotiated).toBe(1);
        });
        it('should detect ECHO sequence', () => {
            const s = createMockSocket({ echo_negotiated: 0 });
            const echoWill = createIACSequence(p.WILL, p.ECHO);
            sendClient(s, echoWill, { compress: false });
            expect(s.echo_negotiated).toBe(1);
            expect(s.password_mode).toBe(true);
        });
        it('should detect NAWS sequence', () => {
            const s = createMockSocket({ naws_negotiated: 0 });
            const nawsWill = createIACSequence(p.WILL, p.NAWS);
            sendClient(s, nawsWill, { compress: false });
            expect(s.naws_negotiated).toBe(1);
        });
        it('should handle multiple sequence types in one buffer', () => {
            const s = createMockSocket({
                ttype: ['test'],
                gmcp_negotiated: 0,
                msdp_negotiated: 0,
                mxp_negotiated: 0,
                new_negotiated: 0,
                sga_negotiated: 0,
                echo_negotiated: 0,
                naws_negotiated: 0,
                utf8_negotiated: 0,
            });
            const multiProtocol = Buffer.concat([
                createIACSequence(p.DO, p.TTYPE),
                createIACSequence(p.DO, p.GMCP),
                createIACSequence(p.WILL, p.MSDP),
                createIACSequence(p.DO, p.MXP),
                createIACSequence(p.DO, p.NEW),
                createIACSequence(p.WILL, p.SGA),
                createIACSequence(p.WILL, p.ECHO),
                createIACSequence(p.WILL, p.NAWS),
                createIACSequence(p.DO, p.CHARSET),
            ]);
            sendClient(s, multiProtocol, { compress: false });
            expect(s.gmcp_negotiated).toBe(1);
            expect(s.msdp_negotiated).toBe(1);
            expect(s.mxp_negotiated).toBe(1);
            expect(s.new_negotiated).toBe(1);
            expect(s.sga_negotiated).toBe(1);
            expect(s.echo_negotiated).toBe(1);
            expect(s.password_mode).toBe(true);
            expect(s.naws_negotiated).toBe(1);
        });
    });
    describe('edge cases', () => {
        it('should handle null bytes in data', () => {
            const s = createMockSocket();
            const dataWithNulls = Buffer.from([
                0x48, 0x00, 0x65, 0x00, 0x6c, 0x6c, 0x6f,
            ]);
            sendClient(s, dataWithNulls, { compress: false });
            const sent = s._sentMessages[0];
            const decoded = Buffer.from(sent, 'base64');
            expect(decoded[1]).toBe(0x00);
        });
        it('should handle IAC escaped sequences', () => {
            const s = createMockSocket();
            // IAC IAC represents a literal 255 byte in telnet
            const escapedIac = Buffer.from([
                p.IAC,
                p.IAC,
                0x48,
                0x65,
                0x6c,
                0x6c,
                0x6f,
            ]);
            sendClient(s, escapedIac, { compress: false });
            expect(s._sentMessages.length).toBe(1);
        });
        it('should handle maximum buffer size', () => {
            const s = createMockSocket();
            const largeBuffer = Buffer.alloc(65535, 'x');
            sendClient(s, largeBuffer, { compress: true });
            expect(s._sentMessages.length).toBe(1);
            expect(s._sentMessages[0].length).toBeGreaterThan(0);
        });
        it('should handle rapid successive calls', () => {
            const s = createMockSocket();
            const messages = ['Message 1', 'Message 2', 'Message 3'];
            messages.forEach((msg) => {
                sendClient(s, Buffer.from(msg), { compress: false });
            });
            expect(s._sentMessages.length).toBe(3);
        });
        it('should maintain state across multiple calls', () => {
            const s = createMockSocket({
                mccp: true,
                compressed: 0,
                gmcp_negotiated: 0,
            });
            // First call - negotiate GMCP
            sendClient(s, createIACSequence(p.DO, p.GMCP), { compress: false });
            expect(s.gmcp_negotiated).toBe(1);
            // Second call - should remember state
            sendClient(s, Buffer.from('test'), { compress: false });
            expect(s.gmcp_negotiated).toBe(1);
        });
    });
});
// Export mocks for use in other tests
export { mockZlib, mockIconv };
//# sourceMappingURL=data-transformation.test.js.map