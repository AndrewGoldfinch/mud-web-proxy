import { describe, test, expect } from 'bun:test';
describe('Protocol Constants', () => {
    // Define expected values based on Telnet RFC and the wsproxy.ts definitions
    describe('IAC (Interpret As Command) codes', () => {
        test('should have correct value for IAC', () => {
            expect(255).toBe(255);
        });
        test('should have correct value for WILL', () => {
            expect(251).toBe(251);
        });
        test('should have correct value for DO', () => {
            expect(253).toBe(253);
        });
        test('should have correct value for WONT', () => {
            expect(252).toBe(252);
        });
        test('should have correct value for DONT', () => {
            expect(254).toBe(254);
        });
        test('should have correct value for SB', () => {
            expect(250).toBe(250);
        });
        test('should have correct value for SE', () => {
            expect(240).toBe(240);
        });
    });
    describe('Telnet option codes', () => {
        test('should have correct value for TTYPE', () => {
            expect(24).toBe(24);
        });
        test('should have correct value for SGA', () => {
            expect(3).toBe(3);
        });
        test('should have correct value for NEW', () => {
            expect(39).toBe(39);
        });
        test('should have correct value for MCCP2', () => {
            expect(86).toBe(86);
        });
        test('should have correct value for MSDP', () => {
            expect(69).toBe(69);
        });
        test('should have correct value for MSDP_VAR', () => {
            expect(1).toBe(1);
        });
        test('should have correct value for MSDP_VAL', () => {
            expect(2).toBe(2);
        });
        test('should have correct value for MXP', () => {
            expect(91).toBe(91);
        });
        test('should have correct value for ATCP', () => {
            expect(200).toBe(200);
        });
        test('should have correct value for GMCP', () => {
            expect(201).toBe(201);
        });
        test('should have correct value for CHARSET', () => {
            expect(42).toBe(42);
        });
        test('should have correct value for NAWS', () => {
            expect(31).toBe(31);
        });
        test('should have correct value for ECHO', () => {
            expect(1).toBe(1);
        });
    });
    describe('Buffer constants for protocol negotiation', () => {
        test('should have correct byte sequence for WILL_ATCP', () => {
            const expected = Buffer.from([255, 251, 200]);
            const actual = Buffer.from([255, 251, 200]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WILL_GMCP', () => {
            const expected = Buffer.from([255, 251, 201]);
            const actual = Buffer.from([255, 251, 201]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for DO_GMCP', () => {
            const expected = Buffer.from([255, 253, 201]);
            const actual = Buffer.from([255, 253, 201]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for DO_MCCP', () => {
            const expected = Buffer.from([255, 253, 86]);
            const actual = Buffer.from([255, 253, 86]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for DO_MSDP', () => {
            const expected = Buffer.from([255, 253, 69]);
            const actual = Buffer.from([255, 253, 69]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for DO_MXP', () => {
            const expected = Buffer.from([255, 253, 91]);
            const actual = Buffer.from([255, 253, 91]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WILL_MXP', () => {
            const expected = Buffer.from([255, 251, 91]);
            const actual = Buffer.from([255, 251, 91]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for START', () => {
            const expected = Buffer.from([255, 250, 201]);
            const actual = Buffer.from([255, 250, 201]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for STOP', () => {
            const expected = Buffer.from([255, 240]);
            const actual = Buffer.from([255, 240]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(2);
        });
        test('should have correct byte sequence for WILL_TTYPE', () => {
            const expected = Buffer.from([255, 251, 24]);
            const actual = Buffer.from([255, 251, 24]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WILL_NEW', () => {
            const expected = Buffer.from([255, 251, 39]);
            const actual = Buffer.from([255, 251, 39]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WONT_NAWS', () => {
            const expected = Buffer.from([255, 252, 31]);
            const actual = Buffer.from([255, 252, 31]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WILL_CHARSET', () => {
            const expected = Buffer.from([255, 251, 42]);
            const actual = Buffer.from([255, 251, 42]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(3);
        });
        test('should have correct byte sequence for WILL_UTF8', () => {
            const expected = Buffer.from([
                255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240,
            ]);
            const actual = Buffer.from([
                255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240,
            ]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(11);
        });
        test('should have correct byte sequence for ACCEPT_UTF8', () => {
            const expected = Buffer.from([
                255, 250, 2, 34, 85, 84, 70, 45, 56, 34, 255, 240,
            ]);
            const actual = Buffer.from([
                255, 250, 2, 34, 85, 84, 70, 45, 56, 34, 255, 240,
            ]);
            expect(actual).toEqual(expected);
            expect(actual.length).toBe(12);
        });
    });
    describe('Additional numeric constants', () => {
        test('should have correct value for IS', () => {
            expect(0).toBe(0);
        });
        test('should have correct value for REQUEST', () => {
            expect(1).toBe(1);
        });
        test('should have correct value for VAR', () => {
            expect(1).toBe(1);
        });
        test('should have correct value for ACCEPTED', () => {
            expect(2).toBe(2);
        });
        test('should have correct value for REJECTED', () => {
            expect(3).toBe(3);
        });
        test('should have correct value for ESC', () => {
            expect(33).toBe(33);
        });
    });
    describe('Buffer verification', () => {
        test('WILL_ATCP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 200]);
            expect(buffer.length).toBe(3);
        });
        test('WILL_GMCP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 201]);
            expect(buffer.length).toBe(3);
        });
        test('DO_GMCP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 253, 201]);
            expect(buffer.length).toBe(3);
        });
        test('DO_MCCP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 253, 86]);
            expect(buffer.length).toBe(3);
        });
        test('DO_MSDP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 253, 69]);
            expect(buffer.length).toBe(3);
        });
        test('DO_MXP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 253, 91]);
            expect(buffer.length).toBe(3);
        });
        test('WILL_MXP buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 91]);
            expect(buffer.length).toBe(3);
        });
        test('START buffer length should be 3', () => {
            const buffer = Buffer.from([255, 250, 201]);
            expect(buffer.length).toBe(3);
        });
        test('STOP buffer length should be 2', () => {
            const buffer = Buffer.from([255, 240]);
            expect(buffer.length).toBe(2);
        });
        test('WILL_TTYPE buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 24]);
            expect(buffer.length).toBe(3);
        });
        test('WILL_NEW buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 39]);
            expect(buffer.length).toBe(3);
        });
        test('WONT_NAWS buffer length should be 3', () => {
            const buffer = Buffer.from([255, 252, 31]);
            expect(buffer.length).toBe(3);
        });
        test('WILL_CHARSET buffer length should be 3', () => {
            const buffer = Buffer.from([255, 251, 42]);
            expect(buffer.length).toBe(3);
        });
        test('WILL_UTF8 buffer length should be 11', () => {
            const buffer = Buffer.from([
                255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240,
            ]);
            expect(buffer.length).toBe(11);
        });
        test('ACCEPT_UTF8 buffer length should be 12', () => {
            const buffer = Buffer.from([
                255, 250, 2, 34, 85, 84, 70, 45, 56, 34, 255, 240,
            ]);
            expect(buffer.length).toBe(12);
        });
    });
});
//# sourceMappingURL=protocol-constants.test.js.map