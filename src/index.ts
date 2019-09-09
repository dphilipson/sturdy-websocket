export interface Options {
    allClearResetTime?: number;
    connectTimeout?: number;
    debug?: boolean;
    minReconnectDelay?: number;
    maxReconnectDelay?: number;
    maxReconnectAttempts?: number;
    reconnectBackoffFactor?: number;
    wsConstructor?: new (url: string, protocols?: string | string[]) => any;
    shouldReconnect?(closeEvent: CloseEvent): boolean | Promise<boolean>;
}

interface SturdyWebSocketEventMap extends WebSocketEventMap {
    down: CloseEvent;
    reopen: Event;
}

type WebSocketListener<K extends keyof SturdyWebSocketEventMap> = (
    this: WebSocket,
    event: SturdyWebSocketEventMap[K],
) => any;

type WebSocketListeners = {
    [K in keyof SturdyWebSocketEventMap]?: Array<WebSocketListener<K>>;
} & {
    [key: string]: EventListenerOrEventListenerObject[];
};

const SHOULD_RECONNECT_FALSE_MESSAGE =
    "Provided shouldReconnect() returned false. Closing permanently.";
const SHOULD_RECONNECT_PROMISE_FALSE_MESSAGE =
    "Provided shouldReconnect() resolved to false. Closing permanently.";

export default class SturdyWebSocket implements WebSocket {
    public static readonly DEFAULT_OPTIONS: Required<Options> = {
        allClearResetTime: 5000,
        connectTimeout: 5000,
        debug: false,
        minReconnectDelay: 1000,
        maxReconnectDelay: 30000,
        maxReconnectAttempts: Number.POSITIVE_INFINITY,
        reconnectBackoffFactor: 1.5,
        shouldReconnect: () => true,
        wsConstructor: undefined!,
    };

    public static readonly CONNECTING = 0;
    public static readonly OPEN = 1;
    public static readonly CLOSING = 2;
    public static readonly CLOSED = 3;

    public onclose: ((event: CloseEvent) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onopen: ((event: Event) => void) | null = null;
    public ondown: ((event: CloseEvent) => void) | null = null;
    public onreopen: ((event: Event) => void) | null = null;
    public readonly CONNECTING = SturdyWebSocket.CONNECTING;
    public readonly OPEN = SturdyWebSocket.OPEN;
    public readonly CLOSING = SturdyWebSocket.CLOSING;
    public readonly CLOSED = SturdyWebSocket.CLOSED;

    private readonly protocols?: string | string[];
    private readonly options: Required<Options>;
    private ws?: WebSocket;
    private hasBeenOpened = false;
    private isClosed = false;
    private messageBuffer: any[] = [];
    private nextRetryTime: number = 0;
    private reconnectCount = 0;
    private allClearTimeoutId?: any;
    private connectTimeoutId?: any;
    private binaryTypeInternal?: BinaryType;
    private lastKnownExtensions = "";
    private lastKnownProtocol = "";
    private readonly listeners: WebSocketListeners = {};

    constructor(url: string, options?: Options);
    constructor(
        url: string,
        protocols: string | string[] | undefined,
        options?: Options,
    );
    constructor(
        public readonly url: string,
        protocolsOrOptions?: string | string[] | Options,
        options: Options = {},
    ) {
        if (
            protocolsOrOptions == null ||
            typeof protocolsOrOptions === "string" ||
            Array.isArray(protocolsOrOptions)
        ) {
            this.protocols = protocolsOrOptions;
        } else {
            options = protocolsOrOptions;
        }
        this.options = applyDefaultOptions(options);
        if (!this.options.wsConstructor) {
            if (typeof WebSocket !== "undefined") {
                this.options.wsConstructor = WebSocket;
            } else {
                throw new Error(
                    "WebSocket not present in global scope and no " +
                        "wsConstructor option was provided.",
                );
            }
        }
        this.openNewWebSocket();
    }

    public get binaryType(): BinaryType {
        return this.binaryTypeInternal || "blob";
    }

    public set binaryType(binaryType: BinaryType) {
        this.binaryTypeInternal = binaryType;
        if (this.ws) {
            this.ws.binaryType = binaryType;
        }
    }

    public get bufferedAmount(): number {
        let sum = this.ws ? this.ws.bufferedAmount : 0;
        let hasUnknownAmount = false;
        this.messageBuffer.forEach(data => {
            const byteLength = getDataByteLength(data);
            if (byteLength != null) {
                sum += byteLength;
            } else {
                hasUnknownAmount = true;
            }
        });
        if (hasUnknownAmount) {
            this.debugLog(
                "Some buffered data had unknown length. bufferedAmount()" +
                    " return value may be below the correct amount.",
            );
        }
        return sum;
    }

    public get extensions(): string {
        return this.ws ? this.ws.extensions : this.lastKnownExtensions;
    }

    public get protocol(): string {
        return this.ws ? this.ws.protocol : this.lastKnownProtocol;
    }

    public get readyState(): number {
        return this.isClosed ? SturdyWebSocket.CLOSED : SturdyWebSocket.OPEN;
    }

    public close(code?: number, reason?: string): void {
        this.disposeSocket(code, reason);
        this.shutdown();
        this.debugLog("WebSocket permanently closed by client.");
    }

    public send(data: any): void {
        if (this.ws && this.ws.readyState === this.OPEN) {
            this.ws.send(data);
        } else {
            this.messageBuffer.push(data);
        }
    }

    public reconnect(): void {
        if (this.isClosed) {
            throw new Error(
                "Cannot call reconnect() on socket which is permanently closed.",
            );
        }
        this.disposeSocket(1000, "Client requested reconnect.");
        this.handleClose(undefined);
    }

    public addEventListener<K extends keyof SturdyWebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, event: SturdyWebSocketEventMap[K]) => void,
    ): void;
    public addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void;
    public addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(listener);
    }

    public dispatchEvent(event: Event): boolean {
        return this.dispatchEventOfType(event.type, event);
    }

    public removeEventListener<K extends keyof SturdyWebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, event: SturdyWebSocketEventMap[K]) => void,
    ): void;
    public removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void;
    public removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
    ): void {
        if (this.listeners[type]) {
            this.listeners[type] = this.listeners[type].filter(
                l => l !== listener,
            );
        }
    }

    private openNewWebSocket(): void {
        if (this.isClosed) {
            return;
        }
        const { connectTimeout, wsConstructor } = this.options;
        this.debugLog(`Opening new WebSocket to ${this.url}.`);
        const ws: WebSocket = new wsConstructor(this.url, this.protocols);
        ws.onclose = event => this.handleClose(event);
        ws.onerror = event => this.handleError(event);
        ws.onmessage = event => this.handleMessage(event);
        ws.onopen = event => this.handleOpen(event);
        this.connectTimeoutId = setTimeout(() => {
            // If this is running, we still haven't opened the websocket.
            // Kill it so we can try again.
            this.clearConnectTimeout();
            this.disposeSocket();
            this.handleClose(undefined);
        }, connectTimeout);
        this.ws = ws;
    }

    private handleOpen(event: Event): void {
        if (!this.ws || this.isClosed) {
            return;
        }
        const { allClearResetTime } = this.options;
        this.debugLog("WebSocket opened.");
        if (this.binaryTypeInternal != null) {
            this.ws.binaryType = this.binaryTypeInternal;
        } else {
            this.binaryTypeInternal = this.ws.binaryType;
        }
        this.clearConnectTimeout();
        if (this.hasBeenOpened) {
            this.dispatchEventOfType("reopen", event);
        } else {
            this.dispatchEventOfType("open", event);
            this.hasBeenOpened = true;
        }
        this.messageBuffer.forEach(message => this.send(message));
        this.messageBuffer = [];
        this.allClearTimeoutId = setTimeout(() => {
            this.clearAllClearTimeout();
            this.nextRetryTime = 0;
            this.reconnectCount = 0;
            const openTime = (allClearResetTime / 1000) | 0;
            this.debugLog(
                `WebSocket remained open for ${openTime} seconds. Resetting` +
                    " retry time and count.",
            );
        }, allClearResetTime);
    }

    private handleMessage(event: MessageEvent): void {
        if (this.isClosed) {
            return;
        }
        this.dispatchEventOfType("message", event);
    }

    private handleClose(event: CloseEvent | undefined): void {
        if (this.isClosed) {
            return;
        }
        const { maxReconnectAttempts, shouldReconnect } = this.options;
        this.clearConnectTimeout();
        this.clearAllClearTimeout();
        if (this.ws) {
            this.lastKnownExtensions = this.ws.extensions;
            this.lastKnownProtocol = this.ws.protocol;
            this.ws = undefined;
        }
        this.dispatchEventOfType("down", event);
        if (this.reconnectCount >= maxReconnectAttempts) {
            this.stopReconnecting(
                event,
                this.getTooManyFailedReconnectsMessage(),
            );
            return;
        }
        const willReconnect = !event || shouldReconnect(event);
        if (typeof willReconnect === "boolean") {
            this.handleWillReconnect(
                willReconnect,
                event,
                SHOULD_RECONNECT_FALSE_MESSAGE,
            );
        } else {
            willReconnect.then(willReconnectResolved => {
                if (this.isClosed) {
                    return;
                }
                this.handleWillReconnect(
                    willReconnectResolved,
                    event,
                    SHOULD_RECONNECT_PROMISE_FALSE_MESSAGE,
                );
            });
        }
    }

    private handleError(event: Event): void {
        this.dispatchEventOfType("error", event);
        this.debugLog("WebSocket encountered an error.");
    }

    private handleWillReconnect(
        willReconnect: boolean,
        event: CloseEvent | undefined,
        denialReason: string,
    ): void {
        if (willReconnect) {
            this.reestablishConnection();
        } else {
            this.stopReconnecting(event, denialReason);
        }
    }

    private reestablishConnection(): void {
        const {
            minReconnectDelay,
            maxReconnectDelay,
            reconnectBackoffFactor,
        } = this.options;
        this.reconnectCount++;
        const retryTime = this.nextRetryTime;
        this.nextRetryTime = Math.max(
            minReconnectDelay,
            Math.min(
                this.nextRetryTime * reconnectBackoffFactor,
                maxReconnectDelay,
            ),
        );
        setTimeout(() => this.openNewWebSocket(), retryTime);
        const retryTimeSeconds = (retryTime / 1000) | 0;
        this.debugLog(
            `WebSocket was closed. Re-opening in ${retryTimeSeconds} seconds.`,
        );
    }

    private stopReconnecting(
        event: CloseEvent | undefined,
        debugReason: string,
    ): void {
        this.debugLog(debugReason);
        this.shutdown();
        if (event) {
            this.dispatchEventOfType("close", event);
        }
    }

    private shutdown(): void {
        this.isClosed = true;
        this.clearAllTimeouts();
        this.messageBuffer = [];
    }

    private disposeSocket(closeCode?: number, reason?: string): void {
        if (!this.ws) {
            return;
        }
        // Use noop handlers instead of null because some WebSocket
        // implementations, such as the one from isomorphic-ws, raise a stink on
        // unhandled events.
        this.ws.onerror = noop;
        this.ws.onclose = noop;
        this.ws.onmessage = noop;
        this.ws.onopen = noop;
        this.ws.close(closeCode, reason);
        this.ws = undefined;
    }

    private clearAllTimeouts(): void {
        this.clearConnectTimeout();
        this.clearAllClearTimeout();
    }

    private clearConnectTimeout(): void {
        if (this.connectTimeoutId != null) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = undefined;
        }
    }

    private clearAllClearTimeout(): void {
        if (this.allClearTimeoutId != null) {
            clearTimeout(this.allClearTimeoutId);
            this.allClearTimeoutId = undefined;
        }
    }

    private dispatchEventOfType(type: string, event: any): boolean {
        switch (type) {
            case "close":
                if (this.onclose) {
                    this.onclose(event);
                }
                break;
            case "error":
                if (this.onerror) {
                    this.onerror(event);
                }
                break;
            case "message":
                if (this.onmessage) {
                    this.onmessage(event);
                }
                break;
            case "open":
                if (this.onopen) {
                    this.onopen(event);
                }
                break;
            case "down":
                if (this.ondown) {
                    this.ondown(event);
                }
                break;
            case "reopen":
                if (this.onreopen) {
                    this.onreopen(event);
                }
                break;
        }
        if (type in this.listeners) {
            this.listeners[type]
                .slice()
                .forEach(listener => this.callListener(listener, event));
        }
        return !event || !(event as Event).defaultPrevented;
    }

    private callListener(
        listener: EventListenerOrEventListenerObject,
        event: Event,
    ): void {
        if (typeof listener === "function") {
            listener.call(this, event);
        } else {
            listener.handleEvent.call(this, event);
        }
    }

    private debugLog(message: string): void {
        if (this.options.debug) {
            // tslint:disable-next-line:no-console
            console.log(message);
        }
    }

    private getTooManyFailedReconnectsMessage(): string {
        const { maxReconnectAttempts } = this.options;
        return `Failed to reconnect after ${maxReconnectAttempts} ${pluralize(
            "attempt",
            maxReconnectAttempts,
        )}. Closing permanently.`;
    }
}

function applyDefaultOptions(options: Options): Required<Options> {
    const result: any = {};
    Object.keys(SturdyWebSocket.DEFAULT_OPTIONS).forEach(key => {
        const value = (options as any)[key];
        result[key] =
            value === undefined
                ? (SturdyWebSocket.DEFAULT_OPTIONS as any)[key]
                : value;
    });
    return result;
}

function getDataByteLength(data: any): number | undefined {
    if (typeof data === "string") {
        // UTF-16 strings use two bytes per character.
        return 2 * data.length;
    } else if (data instanceof ArrayBuffer) {
        return data.byteLength;
    } else if (data instanceof Blob) {
        return data.size;
    } else {
        return undefined;
    }
}

function pluralize(s: string, n: number): string {
    return n === 1 ? s : `${s}s`;
}

function noop(): void {
    // Nothing.
}
