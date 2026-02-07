import type { WebSocket as WS } from 'ws';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
export interface SocketExtended extends WS {
    req: IncomingMessage & {
        connection: {
            remoteAddress: string;
        };
    };
    ts?: TelnetSocket;
    host?: string;
    port?: number;
    ttype: string[];
    name?: string;
    client?: string;
    mccp?: boolean;
    utf8?: boolean;
    debug?: boolean;
    compressed: number;
    mccp_negotiated?: number;
    mxp_negotiated?: number;
    gmcp_negotiated?: number;
    utf8_negotiated?: number;
    new_negotiated?: number;
    new_handshake?: number;
    sga_negotiated?: number;
    echo_negotiated?: number;
    naws_negotiated?: number;
    msdp_negotiated?: number;
    chat?: number;
    password_mode?: boolean;
    sendUTF: (data: string | Buffer) => void;
    terminate: () => void;
    remoteAddress: string;
}
export interface TelnetSocket extends Socket {
    send: (data: string | Buffer) => void;
}
//# sourceMappingURL=wsproxy.d.ts.map