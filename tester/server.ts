const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 5173,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    if (path === "/") {
      path = "/index.html";
    }

    // Try to serve from tester directory
    const file = Bun.file(`./tester${path}`);
    if (await file.exists()) {
      return new Response(file);
    }

    // Try dist directory
    const distFile = Bun.file(`./tester/dist${path}`);
    if (await distFile.exists()) {
      return new Response(distFile);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`1Sat Wallet Sync Tester running at http://localhost:${server.port}`);
