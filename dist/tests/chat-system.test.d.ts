/**
 * Chat System Tests
 * Tests for chat functionality including broadcasting, sanitization,
 * persistence, and chat log management
 */
declare const mockFs: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding?: string) => string | Buffer;
    promises: {
        readFile: (path: string, encoding?: string) => Promise<string>;
        writeFile: (path: string, data: string) => Promise<void>;
    };
    writeFileSync: (path: string, data: string) => void;
    _setMockFile: (path: string, content: string) => void;
    _clearMockFiles: () => void;
    _setChatLog: (data: string | null) => void;
    _setFileError: (path: string, error: Error) => void;
    _getWrittenFiles: () => Map<string, string>;
};
export { mockFs };
//# sourceMappingURL=chat-system.test.d.ts.map