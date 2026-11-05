import net from "node:net";

export async function createSocks5Server() {
  let connections = 0;
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    socket.once("data", (greeting) => {
      if (greeting[0] !== 0x05) {
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([0x05, 0x00]));
      socket.once("data", (request) => {
        handleConnect(request, socket);
      });
    });
  });

  function handleConnect(request, socket) {
    if (request[0] !== 0x05 || request[1] !== 0x01) {
      socket.destroy();
      return;
    }

    let offset = 4;
    let host;
    const addressType = request[3];

    if (addressType === 0x01) {
      host = [...request.subarray(4, 8)].join(".");
      offset = 8;
    } else if (addressType === 0x03) {
      const length = request[4];
      host = request.subarray(5, 5 + length).toString("utf8");
      offset = 5 + length;
    } else {
      socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      socket.destroy();
      return;
    }

    const port = request.readUInt16BE(offset);
    const target = net.connect(port, host, () => {
      connections += 1;
      sockets.add(target);
      target.on("close", () => sockets.delete(target));
      target.on("error", () => {});
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      socket.pipe(target);
      target.pipe(socket);
    });

    target.on("error", () => {
      if (!socket.destroyed) {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      }
      socket.destroy();
    });
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    url: `socks5h://127.0.0.1:${address.port}`,
    get connections() {
      return connections;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
