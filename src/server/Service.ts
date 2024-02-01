import * as Net from "net";
import * as Crypto from "crypto";

// Source
import * as Interface from "./Interface";

export default class CwsServer {
    private clientList: Map<string, Interface.Iclient>;
    private pingTime: number;
    private handleReceiveDataList: Map<string, Interface.IcallbackReceiveMessage>;

    constructor(server: Interface.IhttpsServer, pingTime = 25000) {
        this.clientList = new Map();
        this.pingTime = pingTime;
        this.handleReceiveDataList = new Map();

        this.create(server);
    }

    sendData = (clientId: string, mode: number, data: string | Buffer, tag = "") => {
        const client = this.checkClient(clientId);

        if (!client) {
            return;
        }

        if (client && client.socket && client.socket.writable) {
            let buffer: Buffer = Buffer.alloc(0);
            let frame0 = 0;

            if (mode === 1) {
                const json = {
                    tag: `cws_${tag}`,
                    message: data
                } as Interface.Imessage;

                buffer = Buffer.from(JSON.stringify(json));
                frame0 = 0x81;
            } else if (mode === 2) {
                buffer = Buffer.from(data);
                frame0 = 0x82;
            }

            const length = buffer.length;

            let frame: Buffer;

            if (length <= 125) {
                frame = Buffer.alloc(length + 2);
                frame[0] = frame0;
                frame[1] = length;
            } else if (length <= 65535) {
                frame = Buffer.alloc(length + 4);
                frame[0] = frame0;
                frame[1] = 126;
                frame.writeUInt16BE(length, 2);
            } else {
                frame = Buffer.alloc(length + 10);
                frame[0] = frame0;
                frame[1] = 127;
                frame.writeBigUInt64BE(BigInt(length), 2);
            }

            buffer.copy(frame, frame.length - length);

            client.socket.write(frame);
        }
    };

    sendDataBroadcast = (data: string, clientId?: string) => {
        for (const [index] of this.clientList) {
            if (!clientId || (clientId && clientId !== index)) {
                this.sendData(index, 1, data, "broadcast");
            }
        }
    };

    receiveData = (tag: string, callback: Interface.IcallbackReceiveMessage) => {
        this.handleReceiveDataList.set(`cws_${tag}`, (clientId, data) => {
            callback(clientId, data);
        });
    };

    receiveDataOff = (tag: string) => {
        if (this.handleReceiveDataList.has(`cws_${tag}`)) {
            this.handleReceiveDataList.delete(`cws_${tag}`);
        }
    };

    private create = (server: Interface.IhttpsServer) => {
        server.on("upgrade", (request: Request, socket: Net.Socket) => {
            if (request.headers["upgrade"] !== "websocket") {
                socket.end("HTTP/1.1 400 Bad Request");

                return;
            }

            socket.write(this.responseHeader(request).join("\r\n"));

            const clientId = this.generateClientId();

            this.clientList.set(clientId, {
                socket,
                buffer: Buffer.alloc(0),
                opCode: -1,
                fragmentList: [],
                pingInterval: undefined
            });

            this.ping(clientId);

            // eslint-disable-next-line no-console
            console.log(
                "@cimo/webSocket - Server - Service.ts - create() - upgrade:",
                `Client ${clientId} - Ip: ${socket.remoteAddress || ""} connected`
            );

            this.sendData(clientId, 1, clientId, "client_connection");

            this.sendDataBroadcast(`Client ${clientId} - Ip: ${socket.remoteAddress || ""} connected`, clientId);

            let messageTagUpload = "";

            socket.on("data", (data: Buffer) => {
                this.handleFrame(clientId, data, (clientOpCode, clientFragmentList) => {
                    if (clientOpCode === 1) {
                        const json = JSON.parse(clientFragmentList as unknown as string) as Interface.Imessage;

                        if (json.tag === "cws_broadcast") {
                            this.sendDataBroadcast(json.message, clientId);
                        } else if (json.tag === "cws_upload") {
                            messageTagUpload = json.tag;
                        }

                        this.handleReceiveData(clientId, json.tag, json.message);
                    } else if ((clientOpCode === 0 || clientOpCode === 2) && messageTagUpload) {
                        this.handleReceiveData(clientId, messageTagUpload, clientFragmentList);

                        messageTagUpload = "";
                    }
                });
            });

            socket.on("end", () => {
                // eslint-disable-next-line no-console
                console.log(
                    "@cimo/webSocket - Server - Service.ts - create() - end:",
                    `Client ${clientId} - Ip: ${socket.remoteAddress || ""} disconnected`
                );

                this.sendDataBroadcast(`Client ${clientId} - Ip: ${socket.remoteAddress || ""} disconnected`, clientId);

                this.cleanup(clientId);
            });
        });
    };

    private responseHeader = (request: Request) => {
        const key = (request.headers["sec-websocket-key"] as string) || "";
        const hash = Crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

        return ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${hash}`, "\r\n"];
    };

    private generateClientId(): string {
        const randomBytes = Crypto.randomBytes(16);

        return randomBytes.toString("hex");
    }

    private checkClient = (clientId: string) => {
        const client = this.clientList.get(clientId);

        if (!client) {
            // eslint-disable-next-line no-console
            console.log("@cimo/webSocket - Server - Service.ts - checkClient():", `Client ${clientId} not exists!`);

            return undefined;
        }

        return client;
    };

    private handleFrame = (clientId: string, data: Buffer, callback: Interface.IcallbackHandleFrame) => {
        const client = this.checkClient(clientId);

        if (!client) {
            return;
        }

        client.buffer = Buffer.concat([client.buffer, data]);

        while (client.buffer.length > 2) {
            let payloadLength = client.buffer[1] & 0x7f;
            let frameLength = payloadLength + 6;
            let maskingKeyStart = 2;

            if (payloadLength === 126) {
                payloadLength = client.buffer.readUInt16BE(2);
                frameLength = payloadLength + 8;
                maskingKeyStart = 4;
            } else if (payloadLength === 127) {
                payloadLength = Number(client.buffer.readBigUInt64BE(2));
                frameLength = payloadLength + 14;
                maskingKeyStart = 10;
            }

            if (client.buffer.length < frameLength) {
                break;
            }

            const frame = client.buffer.slice(0, frameLength);
            client.buffer = client.buffer.slice(frameLength);

            const fin = (frame[0] & 0x80) === 0x80;
            client.opCode = frame[0] & 0x0f;
            const isMasked = frame[1] & 0x80;

            const payloadStart = maskingKeyStart + 4;
            const payload = frame.slice(payloadStart);

            if (isMasked) {
                const maskingKey = frame.slice(maskingKeyStart, payloadStart);

                for (let a = 0; a < payload.length; a++) {
                    payload[a] ^= maskingKey[a % 4];
                }
            }

            if (client.opCode === 0x01 || client.opCode === 0x02 || client.opCode === 0x00) {
                client.fragmentList.push(payload);
            } else if (client.opCode === 0x0a) {
                // eslint-disable-next-line no-console
                console.log("@cimo/webSocket - Server - Service.ts - handleFrame():", `Client ${clientId} pong.`);
            }

            if (fin) {
                const clientOpCode = client.opCode;
                const clientFragmentList = client.fragmentList;

                callback(clientOpCode, clientFragmentList);

                client.buffer = Buffer.alloc(0);
                client.opCode = -1;
                client.fragmentList = [];
            }
        }
    };

    private ping = (clientId: string) => {
        const client = this.checkClient(clientId);

        if (!client) {
            return;
        }

        client.pingInterval = setInterval(() => {
            if (client.socket && client.socket.writable) {
                const frame = Buffer.alloc(2);
                frame[0] = 0x89;
                frame[1] = 0x00;

                client.socket.write(frame);
            }
        }, this.pingTime);
    };

    private handleReceiveData = (clientId: string, tag: string, data: string | Buffer[]) => {
        for (const [index, callback] of this.handleReceiveDataList) {
            if (tag === index) {
                callback(clientId, data);

                return;
            }
        }
    };

    private cleanup = (clientId: string) => {
        const client = this.checkClient(clientId);

        if (!client) {
            return;
        }

        if (client.socket) {
            client.socket.end();

            this.clientList.delete(clientId);
        }
    };
}
