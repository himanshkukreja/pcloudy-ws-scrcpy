import { Server as WSServer } from 'ws';
import WS from 'ws';
import { Service } from './Service';
import { HttpServer, ServerAndPort } from './HttpServer';
import { MwFactory } from '../mw/Mw';
import { EnvName } from '../EnvName';
import * as process from 'process';

export class WebSocketServer implements Service {
    private static instance?: WebSocketServer;
    private servers: WSServer[] = [];
    private mwFactories: Set<MwFactory> = new Set();

    protected constructor() {
        // nothing here
    }

    public static getInstance(): WebSocketServer {
        if (!this.instance) {
            this.instance = new WebSocketServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public registerMw(mwFactory: MwFactory): void {
        this.mwFactories.add(mwFactory);
    }

    public attachToServer(item: ServerAndPort): WSServer {
        const { server, port } = item;
        const TAG = `WebSocket Server {tcp:${port}}`;
        const rboxServicePort = process.env[EnvName.RBOX_SERVICE_PORT] || '4000';
        const internalSecret = process.env[EnvName.INTERNAL_API_SECRET] || '';
        const streamTokenValidateUrl = process.env[EnvName.STREAM_TOKEN_VALIDATE_URL] || `http://127.0.0.1:${rboxServicePort}/api/v1/stream/validate`;
        const wss = new WSServer({ server });
        wss.on('connection', async (ws: WS, request) => {
            if (!request.url) {
                ws.close(4001, `[${TAG}] Invalid url`);
                return;
            }
            const url = new URL(request.url, 'https://example.org/');

            // Validate stream session token if present in connection URL
            const token = url.searchParams.get('token');
            const udid = url.searchParams.get('udid');
            const rid = url.searchParams.get('rid') || undefined;
            if (token && udid) {
                let tokenValid = false;
                try {
                    const validateUrl = buildStreamTokenValidateUrl(streamTokenValidateUrl, { token, udid, rid });
                    const validateRes = await fetch(validateUrl, {
                        headers: { Authorization: internalSecret },
                        signal: AbortSignal.timeout(3000),
                    });
                    if (validateRes.ok) {
                        const body = await validateRes.json() as { valid?: boolean; data?: { valid?: boolean } };
                        tokenValid = body.valid === true || body.data?.valid === true;
                    }
                } catch (e) {
                    console.error(`[${TAG}] Token validation call failed:`, (e as Error).message);
                }
                if (!tokenValid) {
                    ws.close(4003, `[${TAG}] Invalid or expired stream token`);
                    return;
                }
            }

            const action = url.searchParams.get('action') || '';
            let processed = false;
            for (const mwFactory of this.mwFactories.values()) {
                const service = mwFactory.processRequest(ws, { action, request, url });
                if (service) {
                    processed = true;
                    break;
                }
            }
            if (!processed) {
                ws.close(4002, `[${TAG}] Unsupported request`);
            }
            return;
        });
        wss.on('close', () => {
            console.log(`${TAG} stopped`);
        });
        this.servers.push(wss);
        return wss;
    }

    public getServers(): WSServer[] {
        return this.servers;
    }

    public getName(): string {
        return `WebSocket Server Service`;
    }

    public async start(): Promise<void> {
        const service = HttpServer.getInstance();
        const servers = await service.getServers();
        servers.forEach((item) => {
            this.attachToServer(item);
        });
    }

    public release(): void {
        this.servers.forEach((server) => {
            server.close();
        });
    }
}


function buildStreamTokenValidateUrl(baseUrl: string, params: { token: string; udid: string; rid?: string }): string {
    const query = new URLSearchParams({ token: params.token, udid: params.udid });
    if (params.rid) {
        query.set('rid', params.rid);
    }
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query.toString()}`;
}
