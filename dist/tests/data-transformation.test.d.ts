/**
 * Data Transformation Tests
 * Tests for iconv encoding, zlib compression, and protocol parsing
 */
declare const mockZlib: {
    deflateRaw: (data: Buffer, callback: (err: Error | null, buffer: Buffer) => void) => void;
    _setShouldFail: (fail: boolean) => void;
    _getLastCall: () => {
        data: Buffer;
        options: object;
    };
    _clearCalls: () => void;
};
declare const mockIconv: {
    encode: (str: string, encoding: string) => Buffer;
    decode: (buffer: Buffer, encoding: string) => string;
    _setShouldFail: (fail: boolean) => void;
    _getLastCall: () => {
        str: string;
        encoding: string;
    };
    _clearCalls: () => void;
    _getLastEncoded: () => Buffer<ArrayBufferLike> | null;
};
export { mockZlib, mockIconv };
//# sourceMappingURL=data-transformation.test.d.ts.map