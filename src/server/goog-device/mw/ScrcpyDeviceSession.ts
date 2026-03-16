import net from 'net';
import WS from 'ws';
import { AdbUtils } from '../AdbUtils';
import { AdbExtended } from '../adb';
import { SCRCPY_SOCKET_NAME } from '../../../common/Constants';
import { ControlCenter } from '../services/ControlCenter';
import { ScrcpyServer } from '../ScrcpyServer';
import { Device } from '../Device';

// scrcpy 3.x frame header: 8 bytes (flags+PTS) + 4 bytes (packet_size)
const FRAME_HEADER_SIZE = 12;
const IS_CONFIG_FLAG = 0x80000000; // bit 31 of hi-u32 = bit 63 of the 8-byte flags field

// Magic prefixes used by StreamReceiver to dispatch packets
const MAGIC_BYTES_INITIAL = Buffer.from('scrcpy_initial');  // 14 bytes
// Audio packets are tagged so StreamReceiver can emit 'audio' events
// 15 bytes total to remain unique from other magics
const AUDIO_MAGIC = Buffer.from('scrcpy_audio\0\0\0'); // 15 bytes

// scrcpy 3.x video codec IDs (big-endian ASCII of codec name)
const CODEC_H264 = 0x68323634; // 'h264'
const CODEC_H265 = 0x68323635; // 'h265'
const CODEC_AV1  = 0x00617631; // '\0av1'

// scrcpy 3.x audio codec IDs
const CODEC_OPUS = 0x6f707573; // 'opus'
const CODEC_AAC  = 0x00616163; // '\0aac'

// Special audio codec sentinel values
const AUDIO_DISABLED = 0x00000000;
const AUDIO_ERRORED  = 0x00000001;

const DEVICE_NAME_FIELD_LENGTH = 64;

const TAG = '[ScrcpyDeviceSession]';
const GRACE_PERIOD_MS = 3000;

// Max buffered bytes per WebSocket client before we skip sending to that client.
// This prevents slow clients from blocking the event loop.
const MAX_WS_BUFFERED = 1 * 1024 * 1024;

/**
 * Shared per-device session that owns the 3 TCP connections to scrcpy-server
 * and broadcasts video/audio to all connected WebSocket clients.
 *
 * Multiple browser tabs viewing the same device share a single session.
 * When the last client disconnects, a grace period allows for quick
 * reconnection (e.g. page reload) without restarting scrcpy-server.
 */
export class ScrcpyDeviceSession {
    // ─── Static registry ─────────────────────────────────────────────────────

    private static readonly sessions: Map<string, ScrcpyDeviceSession> = new Map();
    private static readonly deviceLocks: Map<string, Promise<void>> = new Map();

    // ─── Instance state ──────────────────────────────────────────────────────

    private readonly clients: Set<WS> = new Set();
    // Clients that haven't received a live IDR yet. They only get config/IDR
    // frames — P-frames are skipped to avoid corruption.
    private readonly waitingForIdr: Set<WS> = new Set();
    private videoSocket?: net.Socket;
    private audioSocket?: net.Socket;
    private controlSocket?: net.Socket;
    private forwardedPort?: number;
    private released = false;
    private graceTimeout?: ReturnType<typeof setTimeout>;

    // Cached state for late-joining clients.
    private cachedInitialMessage?: Buffer;
    private cachedVideoConfigFrame?: Buffer;  // SPS/PPS — needed to init decoder
    private cachedLastIDR?: Buffer;           // Last IDR — shows a frame immediately (avoids "connecting" state)
    private cachedAudioConfig?: Buffer;       // Audio codec config — needed to init audio decoder

    // Track whether init is done so addClient can skip the await
    private initDone = false;

    // Initialization
    private readonly initPromise: Promise<void>;
    private initError?: Error;

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    private constructor(private readonly udid: string) {
        this.initPromise = this.init().then(() => {
            this.initDone = true;
        }).catch((e: Error) => {
            this.initError = e;
            console.error(TAG, `init failed for ${udid}:`, e.message);
            // Remove from registry so future attempts can retry
            if (ScrcpyDeviceSession.sessions.get(this.udid) === this) {
                ScrcpyDeviceSession.sessions.delete(this.udid);
            }
        });
    }

    /**
     * Get an existing session for the device or create a new one.
     * If a session exists but is in its grace period, the timer is cancelled.
     */
    public static getOrCreate(udid: string): ScrcpyDeviceSession {
        let session = ScrcpyDeviceSession.sessions.get(udid);
        if (session && !session.released) {
            // Cancel any pending grace period teardown
            if (session.graceTimeout) {
                clearTimeout(session.graceTimeout);
                session.graceTimeout = undefined;
                console.log(TAG, `grace period cancelled for ${udid} — new client joining`);
            }
            return session;
        }
        console.log(TAG, `creating new session for ${udid}`);
        session = new ScrcpyDeviceSession(udid);
        ScrcpyDeviceSession.sessions.set(udid, session);
        return session;
    }

    /**
     * Add a WebSocket client to this session.
     * Waits for initialization to complete, then sends cached state
     * so the client can start rendering immediately.
     */
    public async addClient(ws: WS): Promise<void> {
        // Fast path: if init is already done, skip the await to avoid
        // yielding to the event loop (which would let broadcast frames
        // slip through before we send the bootstrap sequence).
        if (!this.initDone) {
            await this.initPromise;
        }

        if (this.initError) {
            throw this.initError;
        }
        if (this.released) {
            throw new Error('Session has been released');
        }
        if (ws.readyState !== WS.OPEN) {
            throw new Error('WebSocket not open');
        }

        // Send bootstrap sequence BEFORE adding to the broadcast set.
        // Order: initial message → video config (SPS/PPS) → cached IDR → flush → audio config
        //
        // The cached IDR lets the decoder render a frame immediately (hiding
        // the "connecting" overlay).  The client is still added to waitingForIdr
        // so live P-frames are skipped — they reference frames after the cached
        // IDR that this client never received.  When the next live IDR arrives,
        // the promotion loop sends fresh config + IDR and the client transitions
        // to the live stream cleanly.
        //
        // FLUSH FRAME: The h264-converter's NaluStreamBuffer always holds the
        // last NALU until the next one arrives.  Without the flush, the IDR
        // stays buffered and the decoder never produces a renderable frame
        // (the video stays stuck on "Connecting" until the screen changes).
        // Sending a second copy of the config (SPS/PPS) after the IDR pushes
        // the IDR out of the stream buffer and into the remuxer.
        if (this.cachedInitialMessage) {
            ws.send(this.cachedInitialMessage);
        }
        if (this.cachedVideoConfigFrame) {
            ws.send(this.cachedVideoConfigFrame);
        }
        if (this.cachedLastIDR) {
            ws.send(this.cachedLastIDR);
            // Flush: send config again to push the IDR out of NaluStreamBuffer
            if (this.cachedVideoConfigFrame) {
                ws.send(this.cachedVideoConfigFrame);
            }
        }
        if (this.cachedAudioConfig) {
            ws.send(this.cachedAudioConfig);
        }

        // Mark as waiting — P-frames will be skipped until a live IDR arrives.
        this.waitingForIdr.add(ws);
        this.clients.add(ws);
        console.log(TAG, `client added for ${this.udid} (total: ${this.clients.size})`);
    }

    /**
     * Remove a WebSocket client from this session.
     * If no clients remain, starts a grace period before tearing down.
     */
    public removeClient(ws: WS): void {
        this.clients.delete(ws);
        this.waitingForIdr.delete(ws);
        console.log(TAG, `client removed for ${this.udid} (remaining: ${this.clients.size})`);

        if (this.clients.size === 0 && !this.released) {
            console.log(TAG, `no clients left for ${this.udid} — starting ${GRACE_PERIOD_MS}ms grace period`);
            this.graceTimeout = setTimeout(() => {
                if (this.clients.size === 0 && !this.released) {
                    console.log(TAG, `grace period expired for ${this.udid} — releasing session`);
                    this.release();
                }
            }, GRACE_PERIOD_MS);
        }
    }

    /**
     * Forward a control message from any client to the shared control socket.
     */
    public handleControlMessage(buf: Buffer): void {
        if (!this.controlSocket || this.controlSocket.destroyed) return;
        if (buf.length === 0) return;

        // Filter out ws-scrcpy custom message types that scrcpy v3.1 doesn't understand.
        // Valid scrcpy v3.1 types are 0–17. Custom types (101=video settings, 102=file push)
        // would cause a ControlProtocolException and kill the server.
        const msgType = buf[0];
        if (msgType > 17) return;

        this.controlSocket.write(buf);
    }

    // ─── Initialisation ──────────────────────────────────────────────────────

    private static readonly MAX_INIT_ATTEMPTS = 3;

    private async init(): Promise<void> {
        // Wait for any previous session's cleanup to complete
        const prevLock = ScrcpyDeviceSession.deviceLocks.get(this.udid);
        if (prevLock) {
            console.log(TAG, `waiting for previous session cleanup for ${this.udid}...`);
            await prevLock;
            console.log(TAG, `previous session cleanup done for ${this.udid}`);
        }

        const device = ControlCenter.getInstance().getDevice(this.udid);

        for (let attempt = 1; attempt <= ScrcpyDeviceSession.MAX_INIT_ATTEMPTS; attempt++) {
            try {
                await this.initAttempt(device, attempt);
                return; // success
            } catch (e: any) {
                console.error(TAG, `init attempt ${attempt}/${ScrcpyDeviceSession.MAX_INIT_ATTEMPTS} failed for ${this.udid}: ${e.message}`);

                // Tear down any partial state from this attempt
                this.teardownSockets();
                if (this.forwardedPort) {
                    await AdbUtils.removeForward(this.udid, `tcp:${this.forwardedPort}`).catch(() => undefined);
                    this.forwardedPort = undefined;
                }

                if (attempt === ScrcpyDeviceSession.MAX_INIT_ATTEMPTS) {
                    throw new Error(`init failed after ${ScrcpyDeviceSession.MAX_INIT_ATTEMPTS} attempts: ${e.message}`);
                }

                // Kill scrcpy server before retrying — it accepted our connections
                // but didn't respond, so it's in a bad state.
                if (device) {
                    const pids = await ScrcpyServer.getServerPid(device);
                    if (pids && pids.length > 0) {
                        console.log(TAG, `killing scrcpy PIDs [${pids.join(', ')}] before retry for ${this.udid}`);
                        await Promise.all(pids.map((pid) => device.killProcess(pid).catch(() => undefined)));
                    }
                }

                // Wait before retrying to let the device clean up
                const delay = 500 * attempt;
                console.log(TAG, `retrying in ${delay}ms for ${this.udid}...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    /** Destroy TCP sockets without triggering session release. */
    private teardownSockets(): void {
        [this.videoSocket, this.audioSocket, this.controlSocket].forEach((s) => {
            if (s) {
                s.removeAllListeners();
                s.destroy();
            }
        });
        this.videoSocket = undefined;
        this.audioSocket = undefined;
        this.controlSocket = undefined;
    }

    /** Single init attempt: clean up, start server, connect, handshake. */
    private async initAttempt(device: Device | undefined, attempt: number): Promise<void> {
        const remote = `localabstract:${SCRCPY_SOCKET_NAME}`;

        // 1. Remove any stale ADB forward.
        console.log(TAG, `[attempt ${attempt}] removing stale forward for ${this.udid}...`);
        await AdbUtils.removeForwardByRemote(this.udid, remote);

        // 2. Kill any lingering scrcpy-server process.
        //    scrcpy-server accepts exactly 3 TCP connections then stops listening.
        //    On some devices (e.g. Motorola) the process doesn't exit promptly when
        //    those connections are destroyed — it lingers with a dead listener socket.
        if (device) {
            const oldPids = await ScrcpyServer.getServerPid(device);
            if (oldPids && oldPids.length > 0) {
                console.log(TAG, `[attempt ${attempt}] killing old scrcpy-server PIDs [${oldPids.join(', ')}] for ${this.udid}`);
                await Promise.all(oldPids.map((pid) => device.killProcess(pid).catch(() => undefined)));
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        // 3. Start the scrcpy server + get screen size in parallel.
        console.log(TAG, `[attempt ${attempt}] starting server for ${this.udid}...`);
        const screenSizePromise = this.getScreenSize();
        const serverPromise = device ? device.startServer() : Promise.resolve();
        await Promise.all([screenSizePromise, serverPromise]);
        const screenSize = await screenSizePromise;
        console.log(TAG, `[attempt ${attempt}] server started, screen=${screenSize.width}x${screenSize.height} for ${this.udid}`);

        // 4. Wait for the abstract socket to appear on the device.
        //    The scrcpy process PID appears before the encoder is ready and
        //    before the abstract socket is created.  If we create the ADB
        //    forward too early, connections will be accepted by ADB but
        //    forwarded to a non-existent socket — they succeed at the TCP
        //    level but scrcpy never sees them.
        await this.waitForSocket(device, attempt);

        // 5. Create a FRESH ADB forward.
        this.forwardedPort = await AdbUtils.forward(this.udid, remote);
        const port = this.forwardedPort;
        console.log(TAG, `[attempt ${attempt}] ADB forward port=${port} for ${this.udid}`);

        // Open 3 sequential TCP connections as required by scrcpy 3.x with control=true:
        //   1. video  2. audio  3. control
        console.log(TAG, `[attempt ${attempt}] connecting video TCP for ${this.udid}...`);
        this.videoSocket = await this.connectTcp(port);
        console.log(TAG, `[attempt ${attempt}] video TCP connected for ${this.udid}`);
        console.log(TAG, `[attempt ${attempt}] connecting audio TCP for ${this.udid}...`);
        this.audioSocket = await this.connectTcp(port);
        console.log(TAG, `[attempt ${attempt}] audio TCP connected for ${this.udid}`);
        console.log(TAG, `[attempt ${attempt}] connecting control TCP for ${this.udid}...`);
        this.controlSocket = await this.connectTcp(port);
        console.log(TAG, `[attempt ${attempt}] control TCP connected for ${this.udid}`);

        // Control socket errors must NOT tear down the video/audio pipeline.
        this.controlSocket.once('error', (e) => {
            console.warn(TAG, 'control socket error (controls disabled):', e.message);
            this.controlSocket?.destroy();
            this.controlSocket = undefined;
        });
        this.controlSocket.once('close', () => {
            this.controlSocket = undefined;
        });

        // Start audio piping in the background
        this.pipeAudio(this.audioSocket);

        // Video init: read scrcpy handshake, cache initial message, then pipe frames.
        // If the scrcpy server is in a bad state (e.g. encoder failed), this will
        // timeout via readExact and throw, triggering a retry.
        await this.initVideo(this.videoSocket, screenSize);
    }

    /**
     * Poll the device until the scrcpy abstract socket appears in /proc/net/unix.
     * This ensures the server is actually listening before we create the ADB forward.
     */
    private async waitForSocket(device: Device | undefined, attempt: number): Promise<void> {
        if (!device) return;
        const socketName = SCRCPY_SOCKET_NAME;
        for (let i = 0; i < 20; i++) {
            try {
                const output = await device.runShellCommandAdbKit(
                    `cat /proc/net/unix | grep ${socketName}`,
                );
                if (output && output.includes(socketName)) {
                    console.log(TAG, `[attempt ${attempt}] abstract socket "${socketName}" ready for ${this.udid}`);
                    return;
                }
            } catch (_) { /* ignore */ }
            await new Promise((r) => setTimeout(r, 200));
        }
        // Don't throw — proceed anyway and let readExact timeout catch it
        console.warn(TAG, `[attempt ${attempt}] abstract socket "${socketName}" not found after polling, proceeding anyway for ${this.udid}`);
    }

    private async getScreenSize(): Promise<{ width: number; height: number }> {
        try {
            const client = AdbExtended.createClient();
            const stream = await client.shell(this.udid, 'wm size');
            const output = await AdbExtended.util.readAll(stream);
            const match = output.toString().match(/Physical size:\s*(\d+)x(\d+)/);
            if (match) {
                return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
            }
        } catch (_) { /* fall through to default */ }
        return { width: 1080, height: 1920 };
    }

    // ─── TCP helpers ─────────────────────────────────────────────────────────

    /**
     * Connect to a local TCP port with retries.
     * scrcpy-server may need a moment after process start before its
     * abstract socket is ready to accept connections.
     */
    private async connectTcp(port: number, retries = 10, delayMs = 200): Promise<net.Socket> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await new Promise<net.Socket>((resolve, reject) => {
                    const socket = net.createConnection({ host: '127.0.0.1', port });
                    const timer = setTimeout(() => {
                        socket.destroy();
                        reject(new Error(`TCP connect timeout (attempt ${attempt})`));
                    }, 3000);
                    socket.once('connect', () => {
                        clearTimeout(timer);
                        resolve(socket);
                    });
                    socket.once('error', (err) => {
                        clearTimeout(timer);
                        reject(err);
                    });
                });
            } catch (e: any) {
                if (attempt === retries) {
                    throw new Error(`TCP connect to port ${port} failed after ${retries} attempts: ${e.message}`);
                }
                console.log(TAG, `TCP connect attempt ${attempt}/${retries} failed: ${e.message}, retrying in ${delayMs}ms...`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
        throw new Error('unreachable');
    }

    /** Read exactly `n` bytes from a socket with a timeout. */
    private readExact(socket: net.Socket, n: number, timeoutMs = 10000): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let received = 0;

            const tryRead = () => {
                while (received < n) {
                    const remaining = n - received;
                    const chunk = socket.read(remaining) as Buffer | null;
                    if (chunk === null) {
                        return;
                    }
                    chunks.push(chunk);
                    received += chunk.length;
                }
                cleanup();
                resolve(Buffer.concat(chunks, n));
            };

            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };

            const onClose = () => {
                cleanup();
                reject(new Error(`Socket closed while reading (got ${received}/${n} bytes)`));
            };

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`readExact timeout: got ${received}/${n} bytes in ${timeoutMs}ms`));
            }, timeoutMs);

            const cleanup = () => {
                clearTimeout(timer);
                socket.removeListener('readable', tryRead);
                socket.removeListener('error', onError);
                socket.removeListener('close', onClose);
            };

            socket.on('readable', tryRead);
            socket.once('error', onError);
            socket.once('close', onClose);
            tryRead();
        });
    }

    /** Read one scrcpy frame (12-byte header + body). */
    private async readFrame(socket: net.Socket): Promise<{ isConfig: boolean; data: Buffer }> {
        const header = await this.readExact(socket, FRAME_HEADER_SIZE);
        const hiFlags = header.readUInt32BE(0);
        const isConfig = !!(hiFlags & IS_CONFIG_FLAG);
        const size = header.readUInt32BE(8);
        const data = await this.readExact(socket, size);
        return { isConfig, data };
    }

    // ─── SPS dimension parsing ───────────────────────────────────────────────

    /**
     * Extract width and height from an H.264 SPS NAL unit.
     * Handles the most common cases (no scaling lists, no frame cropping edge cases).
     * Returns null if parsing fails — callers should treat failure as "no change".
     */
    private static parseSPSDimensions(sps: Buffer): { width: number; height: number } | null {
        try {
            // Find the SPS NAL unit — skip leading start codes and look for NAL type 7
            let offset = 0;
            while (offset < sps.length - 4) {
                // Look for 4-byte start code: 00 00 00 01
                if (sps[offset] === 0 && sps[offset + 1] === 0 && sps[offset + 2] === 0 && sps[offset + 3] === 1) {
                    offset += 4;
                    if (offset >= sps.length) break;
                    const nalType = sps[offset] & 0x1f;
                    if (nalType === 7) {
                        // Found SPS NAL unit
                        return ScrcpyDeviceSession.decodeSPSNAL(sps, offset);
                    }
                }
                offset++;
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    /** Decode SPS NAL unit starting at `nalOffset` within `buf`. */
    private static decodeSPSNAL(buf: Buffer, nalOffset: number): { width: number; height: number } | null {
        // Skip NAL header byte (forbidden_zero_bit + nal_ref_idc + nal_unit_type)
        let bytePos = nalOffset + 1;
        let bitPos = 0;

        const readBit = (): number => {
            if (bytePos >= buf.length) throw new Error('buffer overrun');
            const bit = (buf[bytePos] >> (7 - bitPos)) & 1;
            bitPos++;
            if (bitPos === 8) { bitPos = 0; bytePos++; }
            return bit;
        };

        const readBits = (n: number): number => {
            let v = 0;
            for (let i = 0; i < n; i++) v = (v << 1) | readBit();
            return v;
        };

        // Exp-Golomb unsigned
        const readUE = (): number => {
            let leadingZeros = 0;
            while (readBit() === 0) leadingZeros++;
            if (leadingZeros === 0) return 0;
            return (1 << leadingZeros) - 1 + readBits(leadingZeros);
        };

        // Exp-Golomb signed
        const readSE = (): number => {
            const v = readUE();
            return v % 2 === 0 ? -(v >> 1) : (v + 1) >> 1;
        };

        const profileIdc = readBits(8);    // profile_idc
        readBits(8);                        // constraint flags + reserved
        readBits(8);                        // level_idc
        readUE();                           // seq_parameter_set_id

        if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
            const chromaFormatIdc = readUE();
            if (chromaFormatIdc === 3) readBit(); // separate_colour_plane_flag
            readUE();  // bit_depth_luma_minus8
            readUE();  // bit_depth_chroma_minus8
            readBit(); // qpprime_y_zero_transform_bypass_flag
            const seqScalingMatrixPresentFlag = readBit();
            if (seqScalingMatrixPresentFlag) {
                const count = chromaFormatIdc !== 3 ? 8 : 12;
                for (let i = 0; i < count; i++) {
                    if (readBit()) { // seq_scaling_list_present_flag[i]
                        const size = i < 6 ? 16 : 64;
                        let lastScale = 8, nextScale = 8;
                        for (let j = 0; j < size; j++) {
                            if (nextScale !== 0) nextScale = (lastScale + readSE() + 256) % 256;
                            lastScale = nextScale === 0 ? lastScale : nextScale;
                        }
                    }
                }
            }
        }

        readUE();  // log2_max_frame_num_minus4
        const picOrderCntType = readUE();
        if (picOrderCntType === 0) {
            readUE(); // log2_max_pic_order_cnt_lsb_minus4
        } else if (picOrderCntType === 1) {
            readBit();  // delta_pic_order_always_zero_flag
            readSE();   // offset_for_non_ref_pic
            readSE();   // offset_for_top_to_bottom_field
            const numRefFramesInPicOrderCntCycle = readUE();
            for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) readSE();
        }
        readUE();  // max_num_ref_frames
        readBit(); // gaps_in_frame_num_value_allowed_flag

        const picWidthInMbsMinus1 = readUE();
        const picHeightInMapUnitsMinus1 = readUE();
        const frameMbsOnlyFlag = readBit();
        if (!frameMbsOnlyFlag) readBit(); // mb_adaptive_frame_field_flag

        readBit(); // direct_8x8_inference_flag

        let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
        const frameCroppingFlag = readBit();
        if (frameCroppingFlag) {
            cropLeft   = readUE();
            cropRight  = readUE();
            cropTop    = readUE();
            cropBottom = readUE();
        }

        const cropUnitX = 2;
        const cropUnitY = frameMbsOnlyFlag ? 2 : 4;
        const width  = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
        const height = (picHeightInMapUnitsMinus1 + 1) * 16 * (frameMbsOnlyFlag ? 1 : 2) - cropUnitY * (cropTop + cropBottom);

        if (width <= 0 || height <= 0 || width > 7680 || height > 4320) return null;
        return { width, height };
    }

    // Current screen dimensions tracked for mid-stream rotation detection
    private currentScreenWidth = 0;
    private currentScreenHeight = 0;

    // ─── Video pipeline ───────────────────────────────────────────────────────

    private async initVideo(
        socket: net.Socket,
        adbScreenSize: { width: number; height: number },
    ): Promise<void> {
        // 1. Discard 1-byte dummy (only sent on the video / first socket)
        console.log(TAG, `initVideo: waiting for 1-byte dummy for ${this.udid}...`);
        await this.readExact(socket, 1);
        console.log(TAG, `initVideo: got dummy byte for ${this.udid}`);

        // 2. Read device name (64 bytes, null-padded UTF-8)
        const nameBuf = await this.readExact(socket, DEVICE_NAME_FIELD_LENGTH);
        const nullIdx = nameBuf.indexOf(0);
        const deviceName = nameBuf.slice(0, nullIdx === -1 ? DEVICE_NAME_FIELD_LENGTH : nullIdx).toString('utf8');

        // 3. Read video codec metadata: codec_id(4) + width(4) + height(4) = 12 bytes
        const videoMeta = await this.readExact(socket, 12);
        const codecId = videoMeta.readUInt32BE(0);
        const videoWidth = videoMeta.readUInt32BE(4);
        const videoHeight = videoMeta.readUInt32BE(8);
        if (codecId !== CODEC_H264 && codecId !== CODEC_H265 && codecId !== CODEC_AV1) {
            throw new Error(`Unsupported video codec: 0x${codecId.toString(16)}`);
        }
        const codecName = codecId === CODEC_H264 ? 'H264' : codecId === CODEC_H265 ? 'H265' : 'AV1';

        // Use server-reported dimensions, fall back to ADB query
        const screenSize = (videoWidth > 0 && videoHeight > 0)
            ? { width: videoWidth, height: videoHeight }
            : adbScreenSize;
        console.log(TAG, `${deviceName}: ${codecName} ${screenSize.width}x${screenSize.height}`);

        // 4. Read the codec config packet (SPS+PPS for H.264) — first frame in stream
        const configFrame = await this.readFrame(socket);

        // 5. Cache initial message + config.  No clients are connected yet
        //    during init, so we only need to cache — the first addClient()
        //    will send these.  We do NOT cache the first IDR or build a GoP
        //    buffer; the client will receive the next live IDR via broadcast,
        //    which avoids temporal discontinuities that corrupt MediaSource.
        this.currentScreenWidth = screenSize.width;
        this.currentScreenHeight = screenSize.height;
        this.cachedInitialMessage = this.buildInitialMessage(deviceName, screenSize);
        this.cachedVideoConfigFrame = configFrame.data;

        // 6. Resume socket in flowing mode and pipe remaining frames.
        //    readExact uses paused/readable mode; we must explicitly resume
        //    before attaching 'data' listeners.
        socket.resume();
        this.streamFrames(socket, false);
    }

    private buildInitialMessage(
        deviceName: string,
        size: { width: number; height: number },
    ): Buffer {
        const nameBuf = Buffer.alloc(DEVICE_NAME_FIELD_LENGTH);
        Buffer.from(deviceName, 'utf8').copy(nameBuf);

        const displayInfo = Buffer.alloc(24);
        displayInfo.writeInt32BE(0, 0);          // displayId = 0
        displayInfo.writeInt32BE(size.width, 4);
        displayInfo.writeInt32BE(size.height, 8);
        displayInfo.writeInt32BE(0, 12);         // rotation = 0
        displayInfo.writeInt32BE(0, 16);         // layerStack = 0
        displayInfo.writeInt32BE(0, 20);         // flags = 0

        const screenInfo = Buffer.alloc(25);
        screenInfo.writeInt32BE(0, 0);              // contentRect.left = 0
        screenInfo.writeInt32BE(0, 4);              // contentRect.top = 0
        screenInfo.writeInt32BE(size.width, 8);     // contentRect.right = width
        screenInfo.writeInt32BE(size.height, 12);   // contentRect.bottom = height
        screenInfo.writeInt32BE(size.width, 16);    // videoSize.width
        screenInfo.writeInt32BE(size.height, 20);   // videoSize.height
        screenInfo.writeUInt8(0, 24);               // deviceRotation = 0

        const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };

        return Buffer.concat([
            MAGIC_BYTES_INITIAL,
            nameBuf,
            i32(1),           // displaysCount
            displayInfo,
            i32(0),           // connectionCount
            i32(25),          // screenInfoBytesCount
            screenInfo,       // ScreenInfo data
            i32(0),           // videoSettingsBytesCount
            i32(0),           // encodersCount
            i32(1),           // clientId
        ]);
    }

    // ─── Frame streaming ─────────────────────────────────────────────────────

    /**
     * Detect if a raw H.264 payload starts with an IDR keyframe.
     * Checks for 4-byte start code (00 00 00 01) followed by NAL type 5.
     */
    private static isKeyFrame(payload: Buffer): boolean {
        if (payload.length >= 5 &&
            payload[0] === 0 && payload[1] === 0 && payload[2] === 0 && payload[3] === 1) {
            return (payload[4] & 0x1f) === 5;
        }
        return false;
    }

    /** Stream frames from `socket` and broadcast to all connected clients. */
    private streamFrames(socket: net.Socket, isAudio: boolean): void {
        let buf = Buffer.alloc(0);

        const onData = (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);

            while (buf.length >= FRAME_HEADER_SIZE) {
                const size = buf.readUInt32BE(8);
                const total = FRAME_HEADER_SIZE + size;
                if (buf.length < total) break;

                const isConfig = !!(buf.readUInt32BE(0) & IS_CONFIG_FLAG);
                const payload = buf.slice(FRAME_HEADER_SIZE, total);
                buf = buf.slice(total);

                if (isAudio) {
                    const flag = Buffer.alloc(1);
                    flag[0] = isConfig ? 1 : 0;
                    const packet = Buffer.concat([AUDIO_MAGIC, flag, payload]);
                    // Cache audio config so late-joining clients can init their decoder
                    if (isConfig) {
                        this.cachedAudioConfig = packet;
                    }
                    this.broadcastToClients(packet);
                } else {
                    // Keep video config cache up to date.
                    if (isConfig) {
                        this.cachedVideoConfigFrame = payload;

                        // Detect mid-stream resolution change (e.g. device auto-rotation).
                        // When the device rotates, scrcpy sends a new SPS/PPS config frame
                        // with swapped width/height. Parse the new dimensions and, if they
                        // differ, broadcast an updated scrcpy_initial message so all
                        // connected clients can call reOrientScreen() with the new size.
                        const newSize = ScrcpyDeviceSession.parseSPSDimensions(payload);
                        if (newSize &&
                            (newSize.width !== this.currentScreenWidth || newSize.height !== this.currentScreenHeight)) {
                            console.log(TAG, `mid-stream resolution change for ${this.udid}: ` +
                                `${this.currentScreenWidth}x${this.currentScreenHeight} → ${newSize.width}x${newSize.height}`);
                            this.currentScreenWidth = newSize.width;
                            this.currentScreenHeight = newSize.height;
                            // Rebuild initial message with new dimensions.
                            // Preserve the device name from the existing cached message (bytes 14..77).
                            const deviceName = this.cachedInitialMessage
                                ? this.cachedInitialMessage.slice(
                                    MAGIC_BYTES_INITIAL.length,
                                    MAGIC_BYTES_INITIAL.length + DEVICE_NAME_FIELD_LENGTH,
                                  ).toString('utf8').replace(/\0+$/, '')
                                : '';
                            const updatedInitial = this.buildInitialMessage(deviceName, newSize);
                            this.cachedInitialMessage = updatedInitial;
                            // Broadcast the new initial message to all currently connected clients
                            this.broadcastToClients(updatedInitial);
                        }
                    }

                    const isKey = !isConfig && ScrcpyDeviceSession.isKeyFrame(payload);

                    // Cache every IDR so late-joining clients get an instant frame.
                    if (isKey) {
                        this.cachedLastIDR = payload;
                    }

                    if (isKey && this.waitingForIdr.size > 0) {
                        // Live IDR arrived — send config + IDR + flush to waiting clients
                        // directly, then promote them after the broadcast below.
                        for (const ws of this.waitingForIdr) {
                            if (ws.readyState === WS.OPEN) {
                                if (this.cachedVideoConfigFrame) {
                                    ws.send(this.cachedVideoConfigFrame);
                                }
                                ws.send(payload);
                                // Flush: re-send config to push IDR out of NaluStreamBuffer
                                if (this.cachedVideoConfigFrame) {
                                    ws.send(this.cachedVideoConfigFrame);
                                }
                            }
                        }
                    }

                    // P-frames skip waiting clients. Config/IDR also skip them
                    // because waiting clients got their data from the promotion
                    // loop above (avoids sending duplicate IDR).
                    this.broadcastToClients(payload, this.waitingForIdr.size > 0);

                    // Now promote: from the next frame onward they receive everything.
                    if (isKey && this.waitingForIdr.size > 0) {
                        this.waitingForIdr.clear();
                    }
                }
            }
        };

        const streamType = isAudio ? 'audio' : 'video';
        socket.on('data', onData);
        socket.once('error', (e) => console.error(TAG, `${streamType} socket error:`, e.message));
        socket.once('close', () => {
            console.log(TAG, `${streamType} socket closed for ${this.udid}`);
            if (!this.released) {
                this.release();
            }
        });
    }

    // ─── Audio pipeline ───────────────────────────────────────────────────────

    private async pipeAudio(socket: net.Socket): Promise<void> {
        try {
            const codecIdBuf = await this.readExact(socket, 4);
            const codecId = codecIdBuf.readUInt32BE(0);

            if (codecId === AUDIO_DISABLED) {
                console.warn(TAG, 'audio disabled or not available on device');
                return;
            }
            if (codecId === AUDIO_ERRORED) {
                console.warn(TAG, 'audio failed to initialise on device');
                return;
            }
            if (codecId !== CODEC_OPUS && codecId !== CODEC_AAC) {
                console.warn(TAG, `Unexpected audio codec: 0x${codecId.toString(16)}, skipping audio`);
                return;
            }
            console.log(TAG, 'audio codec:', codecId === CODEC_OPUS ? 'OPUS' : 'AAC');
            socket.resume();
            this.streamFrames(socket, true);
        } catch (e: any) {
            console.error(TAG, 'audio init error:', e.message);
        }
    }

    // ─── Broadcasting ────────────────────────────────────────────────────────

    private broadcastToClients(data: Buffer, skipWaiting = false): void {
        for (const ws of this.clients) {
            if (ws.readyState !== WS.OPEN) continue;
            if (ws.bufferedAmount > MAX_WS_BUFFERED) continue;
            if (skipWaiting && this.waitingForIdr.has(ws)) continue;
            ws.send(data);
        }
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────────

    private release(): void {
        if (this.released) return;
        console.log(TAG, `releasing session for ${this.udid}`);
        this.released = true;

        if (this.graceTimeout) {
            clearTimeout(this.graceTimeout);
            this.graceTimeout = undefined;
        }

        // Close all remaining client WebSockets
        for (const ws of this.clients) {
            if (ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
                ws.close(1000, 'Session ended');
            }
        }
        this.clients.clear();

        // Destroy TCP sockets
        [this.videoSocket, this.audioSocket, this.controlSocket].forEach((s) => s?.destroy());

        // Remove ADB forward and register a lock so the next session waits for cleanup
        const cleanupPromise = (async () => {
            if (this.forwardedPort) {
                await AdbUtils.removeForward(this.udid, `tcp:${this.forwardedPort}`).catch(() => undefined);
            }
            await new Promise((r) => setTimeout(r, 100));
        })();

        ScrcpyDeviceSession.deviceLocks.set(this.udid, cleanupPromise);
        cleanupPromise.then(() => {
            if (ScrcpyDeviceSession.deviceLocks.get(this.udid) === cleanupPromise) {
                ScrcpyDeviceSession.deviceLocks.delete(this.udid);
            }
        });

        // Remove from registry
        if (ScrcpyDeviceSession.sessions.get(this.udid) === this) {
            ScrcpyDeviceSession.sessions.delete(this.udid);
        }
    }
}
