import { w3cwebsocket } from "websocket";
import { Server } from "ws";
import RobustWebSocket from "../src/index";

const PORT = 9327;
const URL = `ws://localhost:${PORT}`;

let server: Server;
let ws: RobustWebSocket;

// Be careful to always assign created websockets to the top-level ws variable
// so they get cleaned up after the test, or otherwise close them manually.
// Otherwise, they will keep trying to reconnect and mess with following tests!

beforeEach(() => (server = new Server({ port: PORT })));
afterEach(() => {
    server.close();
    ws.close();
});

describe("basic functionality", () => {
    it("should make a connection like a normal WebSocket", done => {
        setupEchoServer();
        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
        });
        const ondown = jest.fn();
        const onreopen = jest.fn();
        const onclose = jest.fn();
        ws.ondown = ondown;
        ws.onreopen = onreopen;
        ws.onclose = onclose;
        ws.onopen = () => ws.send("Echo?");
        ws.onmessage = event => {
            expect(event.data).toEqual("Echo?");
            expect(ondown).not.toHaveBeenCalled();
            expect(onreopen).not.toHaveBeenCalled();
            expect(onclose).not.toHaveBeenCalled();
            done();
        };
    });

    it("should reconnect if the connection is closed", done => {
        let connectCount = 0;
        server.on("connection", connection => {
            switch (connectCount++) {
                case 0:
                    connection.close();
                    break;
                case 1:
                    connection.send("Success");
                    break;
                default:
                    fail("More connections made than expected.");
            }
        });
        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
        });
        const ondown = jest.fn();
        const onreopen = jest.fn();
        const onclose = jest.fn();
        ws.ondown = ondown;
        ws.onreopen = onreopen;
        ws.onclose = onclose;
        ws.onmessage = event => {
            expect(event.data).toEqual("Success");
            expect(connectCount).toEqual(2);
            expect(ondown).toHaveBeenCalledTimes(1);
            expect(onreopen).toHaveBeenCalledTimes(1);
            expect(onclose).not.toHaveBeenCalled();
            done();
        };
    });

    it("should not reconnect if shouldReconnect returns false", done => {
        let connectCount = 0;
        server.on("connection", connection => {
            connectCount++;
            connection.close(
                1000,
                connectCount < 3 ? "Minor error" : "Grievous error",
            );
        });
        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
            minReconnectDelay: 10,
            shouldReconnect: event => event.reason === "Minor error",
        });
        ws.onclose = event => {
            expect(connectCount).toEqual(3);
            expect(event.reason).toEqual("Grievous error");
            done();
        };
    });

    it("should use the protocol argument", done => {
        server.on("connection", connection => {
            expect(connection.protocol).toEqual("some-protocol");
            done();
        });
        ws = new RobustWebSocket(URL, "some-protocol", {
            constructor: w3cwebsocket,
        });
    });

    it("should work with event listeners", done => {
        setupEchoServer();
        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
        });
        ws.addEventListener("open", () => ws.send("Echo??"));
        ws.addEventListener("message", event => {
            expect(event.data).toEqual("Echo??");
            done();
        });
    });

    interface GlobalWithWebSocket extends NodeJS.Global {
        WebSocket?: typeof WebSocket;
    }

    it("should default to the global WebSocket if no constructor option", () => {
        const wsGlobal = global as GlobalWithWebSocket;
        const oldGlobalWebSocket = wsGlobal.WebSocket;
        wsGlobal.WebSocket = w3cwebsocket;
        try {
            ws = new RobustWebSocket(URL);
        } finally {
            wsGlobal.WebSocket = oldGlobalWebSocket;
        }
    });

    it("should fail if no global WebSocket and no constructor option", () => {
        // This test is mainly just to be sure that the previous test is
        // actually doing something.
        const wsGlobal = global as GlobalWithWebSocket;
        const oldGlobalWebSocket = wsGlobal.WebSocket;
        wsGlobal.WebSocket = undefined;
        try {
            expect(() => (ws = new RobustWebSocket(URL))).toThrow(/global/);
        } finally {
            wsGlobal.WebSocket = oldGlobalWebSocket;
        }
    });
});

describe("retry backoff", () => {
    // A pretty scrappy test. We can use spies to see all the calls made to
    // setTimeout(), but not to see which of those calls are for scheduling
    // reconnections. Instead, ensure that the expected sequence of calls
    // appears somewhere amongst all the calls.

    const originalSetTimeout = setTimeout;
    let timeoutRequests: number[];

    beforeEach(() => {
        timeoutRequests = [];
        window.setTimeout = (...args: any[]) => {
            timeoutRequests.push(args[1]);
            return (originalSetTimeout as any)(...args);
        };
    });
    afterEach(() => {
        window.setTimeout = originalSetTimeout;
    });

    it("should back off exponentially and stop after max", done => {
        server.on("connection", connection => {
            connection.close();
        });
        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
            minReconnectDelay: 1,
            maxReconnectDelay: 9,
            maxReconnectAttempts: 7,
            reconnectBackoffFactor: 2,
        });
        ws.onclose = () => {
            const expectedSubsequence = [0, 1, 2, 4, 8, 9, 9];
            const unexpectedSubsequence = [...expectedSubsequence, 9];
            expect(
                containsSubsequence(timeoutRequests, expectedSubsequence),
            ).toEqual(true);
            expect(
                containsSubsequence(timeoutRequests, unexpectedSubsequence),
            ).toEqual(false);
            done();
        };
    });
});

describe("buffering", () => {
    it("should send stored messages after reconnecting", done => {
        // Shut down the server for a bit, then make sure the messages go
        // through once it starts up again.
        server.close();
        setTimeout(() => {
            server = new Server({ port: PORT });
            server.on("connection", connection =>
                connection.on("message", message => {
                    expect(message).toEqual("Finally");
                    done();
                }),
            );
        }, 20);

        ws = new RobustWebSocket(URL, undefined, {
            constructor: w3cwebsocket,
            minReconnectDelay: 10,
        });
        ws.send("Finally");
    });
});

describe("connect timeout", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("should retry if socket takes too long to open", () => {
        const wsMock: any = {
            send: jest.fn(),
            close: jest.fn(() => wsMock.onclose()),
        };
        const constructorMock = jest.fn(() => wsMock);
        ws = new RobustWebSocket("", undefined, {
            connectTimeout: 100,
            constructor: constructorMock,
        });
        expect(wsMock.close).not.toHaveBeenCalled();
        expect(constructorMock).toHaveBeenCalledTimes(1);
        jest.runTimersToTime(150);
        expect(wsMock.close).toHaveBeenCalled();
        expect(constructorMock).toHaveBeenCalledTimes(2);
    });
});

function setupEchoServer(): void {
    server.on("connection", connection => {
        connection.on("message", message => {
            connection.send(message);
        });
    });
}

function containsSubsequence<T>(haystack: T[], needle: T[]): boolean {
    let haystackIndex = 0;
    let needleIndex = 0;
    while (true) {
        if (needleIndex >= needle.length) {
            return true;
        } else if (haystackIndex >= haystack.length) {
            return false;
        } else if (haystack[haystackIndex] === needle[needleIndex]) {
            needleIndex++;
        }
        haystackIndex++;
    }
}
