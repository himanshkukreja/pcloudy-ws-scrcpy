import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';
import { ScrcpyDeviceSession } from './ScrcpyDeviceSession';

const TAG = '[ScrcpyTcpProxy]';

/**
 * Thin per-WebSocket-client wrapper that delegates all TCP/protocol work
 * to a shared {@link ScrcpyDeviceSession}.
 *
 * Multiple browser tabs viewing the same device each get their own
 * ScrcpyTcpProxy instance, but they all share a single device session
 * (and therefore a single set of scrcpy TCP connections).
 */
export class ScrcpyTcpProxy extends Mw {
    public static readonly TAG = TAG;

    private session?: ScrcpyDeviceSession;
    private released = false;

    public static processRequest(ws: WS, params: RequestParameters): ScrcpyTcpProxy | undefined {
        const { action, url } = params;
        // Handle both direct scrcpy TCP streams and proxy-adb requests.
        // Signed/protected URLs use action=proxy-adb with a remote=tcp:PORT
        // parameter, but the scrcpy server speaks raw TCP (not WebSocket),
        // so the generic WebSocket proxy can't handle it.  We intercept
        // proxy-adb requests here and route them through the shared
        // ScrcpyDeviceSession instead.
        if (action !== ACTION.STREAM_SCRCPY_TCP && action !== ACTION.PROXY_ADB) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Missing udid parameter`);
            return;
        }
        return new ScrcpyTcpProxy(ws, udid);
    }

    private constructor(ws: WS, private readonly udid: string) {
        super(ws);
        this.attachToSession().catch((e: Error) => {
            console.error(TAG, e.message);
            if (!this.released) {
                (ws as WS).close(4005, e.message);
            }
        });
    }

    private async attachToSession(): Promise<void> {
        const session = ScrcpyDeviceSession.getOrCreate(this.udid);
        try {
            await session.addClient(this.ws as WS);
        } catch (e) {
            // addClient failed (e.g. WS closed during init, or init error).
            // Call removeClient to trigger a grace period check — otherwise the
            // session would be orphaned in the registry with 0 clients forever.
            session.removeClient(this.ws as WS);
            throw e;
        }
        this.session = session;

        // If the WS was closed while we were awaiting addClient (e.g. tab
        // closed during init), the release() call already fired but couldn't
        // call removeClient because this.session wasn't set yet.  Clean up now.
        if (this.released) {
            session.removeClient(this.ws as WS);
            this.session = undefined;
        }
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (!this.session) return;

        let buf: Buffer;
        const { data } = event;
        if (data instanceof Buffer) {
            buf = data;
        } else if (data instanceof ArrayBuffer) {
            buf = Buffer.from(data);
        } else if (typeof data === 'string') {
            buf = Buffer.from(data);
        } else {
            return;
        }

        this.session.handleControlMessage(buf);
    }

    public release(): void {
        if (this.released) return;
        this.released = true;

        if (this.session) {
            this.session.removeClient(this.ws as WS);
            this.session = undefined;
        }

        super.release();
    }
}
