import defaults = require("lodash.defaults");

export interface AllOptions {
    allClearResetTime: number;
    connectTimeout: number;
    minReconnectDelay: number;
    maxReconnectDelay: number;
    protocols?: string | string[];
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
};

export default class RobustWebsocket implements WebSocket {
    public static readonly DEFAULT_OPTIONS: AllOptions = {
        allClearResetTime: 30000,
        connectTimeout: 4000,
        minReconnectDelay: 1000,
        maxReconnectDelay: 30000,
        protocols: undefined,
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
    private readonly listeners: WebSocketListeners = {
        close: [],
        error: [],
        message: [],
        open: [],
    };

    constructor(private readonly _url: string, options?: Options) {
        this.options = defaults({}, options, RobustWebsocket.DEFAULT_OPTIONS);
    }

    public get binaryType(): string {
        return "foo";
    }

    public set binaryType(binaryType: string): void {
        // TODO
    }

    public get bufferedAmount(): number {
        return undefined!;
    }

    public get extensions(): string {
        return "foo";
    }

    public get protocol(): string {
        return "foo";
    }

    public get readyState(): number {
        return 0;
    }

    public get url(): string {
        return this._url;
    }

    public close(code?: number, reason?: string): void {
        // TODO
    }

    public send(data: any): void {
        // TODO
    }

    public addEventListener<K extends keyof WebSocketEventMap>(
        type: K,
        listener: (this: WebSocket, event: WebSocketEventMap[K]) => any,
        useCapture?: boolean,
    ): void;
    public addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        useCapture?: boolean,
    ): void {
        // TODO
    }

    public dispatchEvent(event: Event): boolean {
        return false;
    }

    public removeEventListener(
        type: string,
        listener?: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void {
        // TODO
    }
}

function noop(): void {
    return undefined;
}
