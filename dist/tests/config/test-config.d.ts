/**
 * Test configuration
 */
export declare const TEST_CONFIG: {
    readonly websocket: {
        readonly port: 6201;
        readonly host: "localhost";
        readonly secure: false;
    };
    readonly telnet: {
        readonly port: 7000;
        readonly host: "localhost";
    };
    readonly timeouts: {
        readonly default: 5000;
        readonly short: 1000;
        readonly long: 10000;
        readonly connection: 2000;
    };
    readonly testData: {
        readonly mockHost: "test.mud.example.com";
        readonly mockPort: 5000;
        readonly defaultTtype: "xterm-256color";
        readonly testUser: "TestUser";
        readonly testClient: "test-client";
    };
    readonly features: {
        readonly mccp: true;
        readonly mxp: true;
        readonly gmcp: true;
        readonly msdp: true;
        readonly utf8: true;
        readonly debug: true;
    };
    readonly protocols: {
        readonly IAC: 255;
        readonly DONT: 254;
        readonly DO: 253;
        readonly WONT: 252;
        readonly WILL: 251;
        readonly SB: 250;
        readonly SE: 240;
        readonly TTYPE: 24;
        readonly NAWS: 31;
        readonly SGA: 3;
        readonly ECHO: 1;
        readonly MCCP2: 86;
        readonly MXP: 91;
        readonly MSDP: 69;
        readonly GMCP: 201;
        readonly NEW: 39;
        readonly CHARSET: 42;
    };
};
export declare function getTestEnv(): string;
export declare function isDebugMode(): boolean;
export declare const PATHS: {
    readonly root: string;
    readonly tests: `${string}/tests`;
    readonly mocks: `${string}/tests/mocks`;
    readonly fixtures: `${string}/tests/fixtures`;
};
export declare function getMockWebSocketUrl(port?: number): string;
export declare function getMockTelnetAddress(port?: number): string;
//# sourceMappingURL=test-config.d.ts.map