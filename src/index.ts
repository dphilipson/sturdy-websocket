import defaults = require("lodash.defaults");

export interface AllOptions {
    allClearResetTime: number;
    connectTimeout: number;
    debug: boolean;
    minReconnectDelay: number;
    maxReconnectDelay: number;
    reconnectBackoffFactor: number;
    shouldReconnect(closeEvent: CloseEvent): boolean;
    wsFactory(url: string, protocols?: string | string[]): WebSocket;
}

export type Options = Partial<AllOptions>;

type WebSocketListener<K extends keyof WebSocketEventMap> = (
    this: WebSocket,
    event: WebSocketEventMap[K],
) => any;

type WebSocketListeners = {
    [K in keyof WebSocketEventMap]: Array<WebSocketListener<K>>
} & {
    [key: string]: EventListenerOrEventListenerObject[];
};

export default class RobustWebsocket implements WebSocket {
    public static readonly DEFAULT_OPTIONS: AllOptions = {
        allClearResetTime: 30000,
        connectTimeout: 4000,
        debug: false,
        minReconnectDelay: 1000,
        maxReconnectDelay: 30000,
        reconnectBackoffFactor: 1.5,
        shouldReconnect: () => true,
        wsFactory: (url: string, protocols?: string | string[]) =>
            new WebSocket(url, protocols),
    };

    public onclose: (event: CloseEvent) => any = noop;
    public onerror: (event: Event) => any = noop;
    public onmessage: (event: MessageEvent) => any = noop;
    public onopen: (event: Event) => any = noop;
    public readonly CLOSED = WebSocket.CLOSED;
    public readonly CLOSING = WebSocket.CLOSING;
    public readonly CONNECTING = WebSocket.CONNECTING;
    public readonly OPEN = WebSocket.OPEN;

    private readonly options: AllOptions;
    private ws?: WebSocket;
    private isClosed = false;
    private messageBuffer: any[];
    private nextRetryTime: number = 0;
    private allClearTimeoutId?: number;
    private connectTimeoutId?: number;
    private _binaryType = "blob";
    private lastKnownExtensions = "";
    private lastKnownProtocol = "";
    private readonly listeners: WebSocketListeners = {
        close: [],
        error: [],
        message: [],
        open: [],
    };

    constructor(
        private readonly _url: string,
        private readonly protocols?: string | string[],
        options?: Options,
    ) {
        this.options = defaults({}, options, RobustWebsocket.DEFAULT_OPTIONS);
        this.openNewWebSocket();
    }

    public get binaryType(): string {
        return this._binaryType;
    }

    public set binaryType(binaryType: string) {
        this._binaryType = binaryType;
        if (this.ws) {
            this.ws.binaryType = binaryType;
        }
    }

    public get bufferedAmount(): number {
        let sum = 0;
        this.messageBuffer.forEach(data => {
            const byteLength = getDataByteLength(data);
            if (byteLength != null) {
                sum += byteLength;
            } else {
                this.debugLog(
                    "Some buffered data had unknown length. bufferedAmount()" +
                        " return value may be below the correct amount.",
                );
            }
        });
        return undefined!;
    }

    public get extensions(): string {
        return this.ws ? this.ws.extensions : this.lastKnownExtensions;
    }

    public get protocol(): string {
        return this.ws ? this.ws.protocol : this.lastKnownProtocol;
    }

    public get readyState(): number {
        return this.isClosed ? WebSocket.CLOSED : WebSocket.OPEN;
    }

    public get url(): string {
        return this._url;
    }

    public close(code?: number, reason?: string): void {
        if (this.ws) {
            this.ws.close(code, reason);
        }
        this.shutdown();
        this.debugLog("WebSocket permanently closed by client.");
    }

    public send(data: any): void {
        if (this.ws) {
            this.ws.send(data);
        } else {
            this.messageBuffer.push(data);
        }
    }

    public addEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, event: WebSocketEventMap[K]) => void,
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
        switch (event.type) {
            case "close":
                this.onclose(event as any);
                break;
            case "error":
                this.onerror(event);
                break;
            case "message":
                this.onmessage(event as any);
                break;
            case "open":
                this.onopen(event);
        }
        if (event.type in this.listeners) {
            this.listeners[event.type]
                .slice()
                .forEach(listener => this.callListener(listener, event));
        }
        return false;
    }

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
        const { connectTimeout, wsFactory } = this.options;
        this.debugLog(`Opening new WebSocket to ${this._url}.`);
        const ws = wsFactory(this._url, this.protocols);
        ws.onclose = event => this.handleClose(event);
        ws.onerror = event => this.handleError(event);
        ws.onmessage = event => this.handleMessage(event);
        ws.onopen = event => this.handleOpen(ws, event);
        this.connectTimeoutId = setTimeout(() => {
            // If this is running, we still haven't opened the websocket.
            // Kill it so we can try again.
            this.clearConnectTimeout();
            ws.close();
        }, connectTimeout);
    }

    private handleOpen(ws: WebSocket, event: Event): void {
        if (this.isClosed) {
            return;
        }
        const { allClearResetTime } = this.options;
        this.debugLog("WebSocket opened.");
        this.ws = ws;
        ws.binaryType = this._binaryType;
        this.clearConnectTimeout();
        this.dispatchEvent(event);
        this.messageBuffer.forEach(message => this.send(message));
        this.messageBuffer = [];
        this.allClearTimeoutId = setTimeout(() => {
            this.clearAllClearTimeout();
            this.nextRetryTime = 0;
            const openTime = (allClearResetTime / 1000) | 0;
            this.debugLog(
                `WebSocket remained open for ${openTime} seconds. Resetting` +
                    " retry time.",
            );
        }, allClearResetTime);
    }

    private handleMessage(event: MessageEvent): void {
        if (this.isClosed) {
            return;
        }
        this.dispatchEvent(event);
    }

    private handleClose(event: CloseEvent): void {
        if (!this.ws || this.isClosed) {
            return;
        }
        this.clearConnectTimeout();
        this.clearAllClearTimeout();
        this.lastKnownExtensions = this.ws.extensions;
        this.lastKnownProtocol = this.ws.protocol;
        this.ws = undefined;
        if (this.options.shouldReconnect(event)) {
            this.reconnect();
        } else {
            this.shutdown();
            this.dispatchEvent(event);
        }
    }

    private handleError(event: Event): void {
        this.dispatchEvent(event);
        this.debugLog("WebSocket encountered an error.");
    }

    private reconnect(): void {
        const {
            minReconnectDelay,
            maxReconnectDelay,
            reconnectBackoffFactor,
        } = this.options;
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

    private shutdown(): void {
        this.isClosed = true;
        this.clearAllTimeouts();
        this.messageBuffer = [];
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
}

function noop(): void {
    return undefined;
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
